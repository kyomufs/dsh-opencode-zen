'use strict'
/**
 * dsh-opencode-zen test stand.
 *
 * Covers: failure taxonomy (DSH-native codes + failure snapshot), retry
 * policy shape against dsh-llm's own resolver, per-model budgets, the
 * Responses wire for muse-spark-*, stream watchdogs, and end-to-end stream()
 * behavior against a local SSE server (happy path, 5xx recovery, hard 5xx,
 * silent tunnel, socket death before/after content, empty completion).
 *
 * Run: node test/smoke.cjs
 */

process.env.DSH_ZEN_FIRST_EVENT_MS = '400'
process.env.DSH_ZEN_IDLE_MS = '600'
process.env.DSH_ZEN_RESPONSES_IDLE_MS = '800'

const assert = require('node:assert')
const http = require('node:http')

const plugin = require('../lib/index.js')
const {
  OpenCodeZenAdapter, MODELS, resolveReasoningEffort, resolveMaxTokens,
  ensureFreeLaneShape, buildResponsesBody, translateStream, translateResponsesStream,
  httpFailure, ensureTyped, isResponsesModel, serializeMessages, retryDelay,
} = plugin

let passed = 0
let failed = 0
const failures = []

function check(label, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${label}`)
  } catch (error) {
    failed += 1
    failures.push({ label, error })
    console.log(`  FAIL ${label}\n       ${error.message}`)
  }
}

async function checkAsync(label, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${label}`)
  } catch (error) {
    failed += 1
    failures.push({ label, error })
    console.log(`  FAIL ${label}\n       ${error.message}`)
  }
}

async function collect(generator) {
  const chunks = []
  for await (const chunk of generator) chunks.push(chunk)
  return chunks
}

// ---------------------------------------------------------------- unit parts

console.log('\n[1] module surface')
check('exports the public API', () => {
  for (const key of ['apply', 'inject', 'name', 'OpenCodeZenAdapter', 'PROVIDER', 'MODELS', 'resolveApiKey', 'resolveReasoningEffort']) {
    assert.ok(key in plugin, `missing export ${key}`)
  }
})
check('nine models with declared budgets', () => {
  assert.strictEqual(MODELS.length, 9)
  for (const model of MODELS) {
    assert.ok(Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0, `${model.id} contextWindow`)
    assert.ok(Number.isSafeInteger(model.maxOutput) && model.maxOutput > 0, `${model.id} maxOutput`)
  }
})
check('muse-spark is the only Responses route', () => {
  const routed = MODELS.filter((m) => m.responses === true).map((m) => m.id)
  assert.deepStrictEqual(routed, ['muse-spark-1.3-contributor-free'])
  assert.ok(isResponsesModel('muse-spark-1.3-contributor-free'))
  assert.ok(!isResponsesModel('mimo-v2.6-flash-free'))
})

console.log('\n[2] model resolution and budgets')
const adapter = new OpenCodeZenAdapter({ get: () => undefined, logger: { info() {}, warn() {} } })

checkAsync('resolveModel exposes per-model context and output budget', async () => {
  const mimo = await adapter.resolveModel('opencode', 'mimo-v2.6-flash-free')
  assert.strictEqual(mimo.context.contextWindow, 200000)
  assert.strictEqual(mimo.defaultMaxTokens, 32000)
  const muse = await adapter.resolveModel('opencode', 'muse-spark-1.3-contributor-free')
  assert.strictEqual(muse.context.contextWindow, 1048576)
  assert.strictEqual(muse.defaultMaxTokens, 131072)
})
checkAsync('unknown model falls back to defaults', async () => {
  const unknown = await adapter.resolveModel('opencode', 'not-a-real-model')
  assert.strictEqual(unknown.context.contextWindow, 200000)
  assert.strictEqual(unknown.defaultMaxTokens, 32000)
})
checkAsync('reasoning ladders match the declared effort sets', async () => {
  const bunny = await adapter.resolveModel('opencode', 'space-bunny-free')
  assert.ok(!bunny.reasoning.efforts.some((e) => e.id === 'off'), 'space-bunny must not offer off')
  assert.ok(bunny.reasoning.efforts.some((e) => e.id === 'max'))
  const muse = await adapter.resolveModel('opencode', 'muse-spark-1.3-contributor-free')
  assert.ok(!muse.reasoning.efforts.some((e) => e.id === 'off'), 'responses model must not offer off')
  assert.ok(!muse.reasoning.efforts.some((e) => e.id === 'max'), 'muse declares no max effort')
  const mimo = await adapter.resolveModel('opencode', 'mimo-v2.6-flash-free')
  assert.ok(mimo.reasoning.efforts.some((e) => e.id === 'off'))
  assert.strictEqual(mimo.reasoning.defaultEffort, 'high')
  // mimo endpoints answer HTTP 500 to minimal/xhigh/max (live-probed
  // 2026-10-02), so neither mimo id may offer them.
  for (const id of ['mimo-v2.5-free', 'mimo-v2.6-flash-free']) {
    const model = await adapter.resolveModel('opencode', id)
    const ids = model.reasoning.efforts.map((e) => e.id)
    assert.deepStrictEqual(ids, ['off', 'low', 'medium', 'high'], `${id} ladder`)
  }
})
check('max tokens clamp to the model budget', () => {
  const mimo = MODELS.find((m) => m.id === 'mimo-v2.6-flash-free')
  assert.strictEqual(resolveMaxTokens(mimo, 128000), 32000)
  assert.strictEqual(resolveMaxTokens(mimo, undefined), 32000)
  assert.strictEqual(resolveMaxTokens(mimo, 1000), 1000)
  assert.strictEqual(resolveMaxTokens(undefined, undefined), 32000)
})
check('reasoning effort wire mapping', () => {
  assert.strictEqual(resolveReasoningEffort('mimo-v2.6-flash-free', 'off'), 'none')
  assert.strictEqual(resolveReasoningEffort('mimo-v2.6-flash-free', 'high'), 'high')
  assert.strictEqual(resolveReasoningEffort('space-bunny-free', undefined), 'high')
  assert.strictEqual(resolveReasoningEffort('mimo-v2.6-flash-free', undefined), undefined)
  // Responses models cannot be silenced: off omits the field entirely.
  assert.strictEqual(resolveReasoningEffort('muse-spark-1.3-contributor-free', 'off'), undefined)
  assert.strictEqual(resolveReasoningEffort('muse-spark-1.3-contributor-free', 'minimal'), 'minimal')
  // Efforts outside the model's declared ladder clamp to the nearest level
  // instead of reaching the wire (mimo answers 500 to max/xhigh/minimal).
  assert.strictEqual(resolveReasoningEffort('mimo-v2.6-flash-free', 'max'), 'high')
  assert.strictEqual(resolveReasoningEffort('mimo-v2.5-free', 'xhigh'), 'high')
  assert.strictEqual(resolveReasoningEffort('mimo-v2.5-free', 'minimal'), 'low')
  assert.strictEqual(resolveReasoningEffort('space-bunny-free', 'max'), 'max')
  assert.strictEqual(resolveReasoningEffort('not-a-real-model', 'max'), 'max')
})

console.log('\n[3] failure taxonomy + host retry policy')
check('HTTP 500 maps to SERVER with the status attached', () => {
  const failure = httpFailure(500, '{"type":"error","error":{"type":"error","message":"Internal server error"}}')
  assert.strictEqual(failure.code, 'SERVER')
  assert.strictEqual(failure.failure.status, 500)
  assert.ok(failure.failure.message.includes('Internal server error'))
})
check('HTTP 429 maps to RATE_LIMIT with Retry-After', () => {
  const failure = httpFailure(429, 'slow down', 15000)
  assert.strictEqual(failure.code, 'RATE_LIMIT')
  assert.strictEqual(failure.failure.providerRetryAfterMs, 15000)
  // The Retry-After must actually reach the delay: read from failure.failure
  // (the payload envelope), not the top level — the old top-level read made
  // asked always 0 and silently capped every delay to ~800ms + jitter.
  assert.strictEqual(retryDelay(0, failure), 15000)
})
check('daily-quota 429 (FreeUsageLimitError, long retry-after) is not hammered', () => {
  const body = JSON.stringify({ type: 'error', error: { type: 'FreeUsageLimitError', message: 'Daily usage limit exceeded' } })
  const failure = httpFailure(429, body, 7200000)
  assert.strictEqual(failure.code, 'RATE_LIMIT', 'still a rate limit for the host policy')
  assert.ok(failure.failure.message.includes('FreeUsageLimitError'), failure.failure.message)
  assert.ok(failure.failure.message.includes('midnight UTC'), failure.failure.message)
  assert.strictEqual(retryDelay(0, failure), null, 'retry-after beyond the cap must skip the in-process sleep')
  // Short windows (hourly key limits, the tail before midnight) still retry.
  const short = httpFailure(429, body, 45000)
  assert.notStrictEqual(retryDelay(0, short), null)
})
check('401 ModelError is terminal and never rotates pool keys', () => {
  const body = JSON.stringify({ type: 'error', error: { type: 'ModelError', message: 'Model jev-1.13-free is not supported' } })
  const failure = httpFailure(401, body)
  assert.strictEqual(failure.code, 'PROVIDER_ERROR')
  assert.ok(failure.failure.message.includes('does not serve this model'), failure.failure.message)
  // Real auth rejections keep INVALID_CREDENTIAL so the pool can rotate.
  const auth = httpFailure(401, JSON.stringify({ type: 'error', error: { type: 'AuthError', message: 'Missing API key' } }))
  assert.strictEqual(auth.code, 'INVALID_CREDENTIAL')
  const bare = httpFailure(401, '{"error":{"message":"invalid api key"}}')
  assert.strictEqual(bare.code, 'INVALID_CREDENTIAL')
})
check('403 RegionError / DataPolicyError names the region gate', () => {
  const failure = httpFailure(403, JSON.stringify({ type: 'error', error: { type: 'RegionError', message: 'Not available in your region' } }))
  assert.strictEqual(failure.code, 'PROVIDER_ERROR')
  assert.ok(failure.failure.message.includes('region/policy gate'), failure.failure.message)
  const policy = httpFailure(403, JSON.stringify({ type: 'error', error: { type: 'DataPolicyError', message: 'blocked by data policy' } }))
  assert.ok(policy.failure.message.includes('region/policy gate'), policy.failure.message)
  // Observed FreeTierError wordings from the live gate 2026-10-02.
  const country = httpFailure(403, '{"error":{"type":"FreeTierError","message":"Error from provider (Console): This model is not available in your country"}}')
  assert.ok(country.failure.message.includes('region gate'), country.failure.message)
  const client = httpFailure(403, '{"error":{"type":"FreeTierError","message":"OpenCode\'s free tier can only be used from within OpenCode"}}')
  assert.ok(client.failure.message.includes('client gate'), client.failure.message)
})
check('HTTP 403 carries an actionable hint and stays non-retryable', () => {
  const gate = httpFailure(403, '{"type":"error","error":{"type":"FreeTierError","message":"x"}}')
  assert.strictEqual(gate.code, 'PROVIDER_ERROR')
  assert.ok(gate.failure.message.includes('canonical ses_ session'))
  const quota = httpFailure(403, '{"model":"mimo-v2.6-flash-free"}')
  assert.strictEqual(quota.code, 'PROVIDER_ERROR')
  assert.ok(quota.failure.message.includes('anonymous-lane refusal'))
  assert.ok(!('providerRetryAfterMs' in quota.failure))
  // A 403 reporting the provider's own outage is transient, not a quota gate.
  const outage = httpFailure(403, '{"error":{"type":"server_error","message":"Error from provider (Console): Upstream request failed: Endpoint is unavailable."}}')
  assert.strictEqual(outage.code, 'SERVER')
  assert.ok(outage.failure.message.includes('upstream provider outage'))
})
check('undici "terminated" becomes a typed TRANSPORT with the cause chain', () => {
  const raw = new TypeError('terminated')
  raw.cause = new Error('other side closed')
  const failure = ensureTyped(raw, {})
  assert.strictEqual(failure.code, 'TRANSPORT')
  assert.ok(failure.failure.message.includes('terminated'))
  assert.ok(failure.failure.message.includes('other side closed'))
})
check('watchdog abort becomes a typed TIMEOUT', () => {
  const raw = new Error('This operation was aborted')
  raw.name = 'AbortError'
  const failure = ensureTyped(raw, { timedOut: true })
  assert.strictEqual(failure.code, 'TIMEOUT')
  assert.ok(failure.failure.message.includes('timed out'))
})
check('caller abort becomes ABORTED', () => {
  const raw = new Error('This operation was aborted')
  raw.name = 'AbortError'
  const failure = ensureTyped(raw, { callerAborted: true })
  assert.strictEqual(failure.code, 'ABORTED')
})
check('already-typed failures pass through untouched', () => {
  const first = httpFailure(500, 'boom')
  const second = ensureTyped(first, { timedOut: true })
  assert.strictEqual(second, first)
})

const DSH_LLM = '/nix/store/qph9ndg6jv1q0gd819j7am0h7nhs8kpy-dsh-0.2.0-rc.2/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js'
const DSH_UTIL_VALUES = '/nix/store/qph9ndg6jv1q0gd819j7am0h7nhs8kpy-dsh-0.2.0-rc.2/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-util-values/lib/index.js'

checkAsync('providerRetryPolicy is the resolved flat policy the host retry reads', async () => {
  const policy = adapter.providerRetryPolicy('opencode')
  // dsh-llm registers adapter-owned policies AS-IS (prepareRoutes never runs
  // resolveRetryPolicy on them). dsh-llm-retry's localDelay reads
  // initialDelayMs/maxDelayMs/jitterRatio from the TOP level; the previous
  // nested `backoff` shape made delayMs = NaN, session.append("llm/retry")
  // rejected the non-finite number and the turn died with
  // `session event "llm/retry" carries non-JSON-serializable data`.
  assert.strictEqual(policy.mode, 'normal')
  assert.strictEqual(policy.initialDelayMs, 800)
  assert.strictEqual(policy.maxDelayMs, 8000)
  assert.strictEqual(policy.jitterRatio, 0.2)
  assert.strictEqual(policy.backoff, undefined, 'backoff must not stay nested')
  assert.strictEqual(policy.maxRetries, 3)
  assert.ok(policy.retryableCodes.includes('SERVER'))
  assert.ok(policy.retryableCodes.includes('RATE_LIMIT'))
  assert.ok(policy.retryableCodes.includes('TRANSPORT'))
  assert.ok(policy.retryableCodes.includes('EMPTY_RESPONSE'))
  assert.ok(!policy.retryableCodes.includes('RATE_LIMITED'), 'the old bogus code must be gone')

  // localDelay as dsh-llm-retry computes it must stay finite for both policy
  // sources (host resolver and standalone fallback).
  const localDelay = (p, retry, random) => {
    const exponential = Math.min(p.initialDelayMs * 2 ** Math.min(retry - 1, 1024), p.maxDelayMs)
    return Math.min(exponential * (1 - p.jitterRatio + 2 * p.jitterRatio * random()), p.maxDelayMs)
  }
  assert.ok(Number.isFinite(localDelay(policy, 1, Math.random)), 'delayMs must be finite')
  assert.ok(Number.isFinite(localDelay(policy, 3, Math.random)), 'delayMs must be finite at max retry')

  // The full llm/retry event payload must survive the host's lossless-JSON
  // snapshot — that check is exactly what threw in production.
  let utilValues
  try { utilValues = await import(DSH_UTIL_VALUES) } catch (error) {
    console.log(`       (snapshot check skipped, dsh-util-values unavailable: ${error.message})`)
    return
  }
  const eventData = {
    retryId: 'r-1',
    turn: 7,
    step: 28,
    provider: 'opencode',
    mode: policy.mode,
    policyKey: JSON.stringify([policy.mode, policy.maxRetries, [...policy.retryableCodes].sort(), policy.initialDelayMs, policy.maxDelayMs, policy.jitterRatio]),
    retry: 1,
    maxRetries: policy.maxRetries,
    delayMs: localDelay(policy, 1, () => 0.5),
    failure: { message: 'OpenCode Zen transport error: fetch failed', code: 'TRANSPORT' },
  }
  assert.notStrictEqual(utilValues.snapshotJsonValue(eventData), undefined, 'llm/retry payload must be JSON-snapshotable')
})

checkAsync('the pre-resolve config shape validates against the host resolver', async () => {
  let dshLlm
  try { dshLlm = require(DSH_LLM) } catch (error) {
    console.log(`       (skipped, dsh-llm unavailable: ${error.message})`)
    return
  }
  const resolved = dshLlm.resolveRetryPolicy({
    mode: 'normal',
    maxRetries: 3,
    retryableCodes: ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE'],
    backoff: { initialDelayMs: 800, maxDelayMs: 8000, jitterRatio: 0.2 },
  }, 'test')
  assert.deepStrictEqual({ ...adapter.providerRetryPolicy('opencode') }, { ...resolved })
})

console.log('\n[4] request shapes')
check('gate tools injected, tool_choice none for tool-less chats', () => {
  const body = ensureFreeLaneShape({ messages: [{ role: 'user', content: 'hi' }] })
  assert.deepStrictEqual(body.tools.map((t) => t.function.name), ['bash', 'read'])
  assert.strictEqual(body.tool_choice, 'none')
})
check('gate tools appended without touching existing tool_choice', () => {
  const body = ensureFreeLaneShape({
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'bash', description: 'x', parameters: {} } }],
    tool_choice: 'auto',
  })
  assert.deepStrictEqual(body.tools.map((t) => t.function.name), ['bash', 'read'])
  assert.strictEqual(body.tool_choice, 'auto')
})
check('Responses body carries instructions, flat tools and reasoning', () => {
  const body = buildResponsesBody({
    model: 'muse-spark-1.3-contributor-free',
    wireMessages: [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello', tool_calls: [{ id: 'call_1', function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'file body' },
    ],
    tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object' } }],
    maxTokens: 4096,
    effort: 'high',
    temperature: undefined,
  })
  assert.strictEqual(body.model, 'muse-spark-1.3-contributor-free')
  assert.strictEqual(body.stream, true)
  assert.strictEqual(body.instructions, 'be terse')
  assert.strictEqual(body.max_output_tokens, 4096)
  assert.deepStrictEqual(body.reasoning, { effort: 'high' })
  assert.strictEqual(body.tool_choice, 'auto')
  const toolNames = body.tools.map((t) => t.name)
  assert.ok(toolNames.includes('read_file') && toolNames.includes('bash') && toolNames.includes('read'))
  assert.ok(body.tools.every((t) => t.type === 'function' && !('function' in t)), 'responses tools must be flat')
  assert.strictEqual(body.input[0].role, 'user')
  const assistant = body.input[1]
  assert.strictEqual(assistant.type, 'message')
  assert.strictEqual(body.input[2].type, 'function_call')
  assert.strictEqual(body.input[3].type, 'function_call_output')
  assert.strictEqual(body.input[3].output, 'file body')
})

console.log('\n[5] stream translators')
checkAsync('chat SSE chunks become harness blocks with a terminal finish', async () => {
  async function* source() {
    yield { choices: [{ delta: { reasoning_content: 'thinking...' } }] }
    yield { choices: [{ delta: { content: 'Hel' } }] }
    yield { choices: [{ delta: { content: 'lo' }, finish_reason: null }] }
    yield { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } } }
  }
  const probe = { sawDone: false, sawFinish: false }
  const chunks = await collect(translateStream(source(), () => '{}', probe))
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
  assert.strictEqual(text, 'Hello')
  assert.strictEqual(reasoning, 'thinking...')
  const usage = chunks.find((c) => c.type === 'usage')
  assert.strictEqual(usage.usage.inputTokens, 6)
  assert.strictEqual(usage.usage.cacheReadTokens, 4)
  const finish = chunks[chunks.length - 1]
  assert.strictEqual(finish.type, 'finish')
  assert.strictEqual(finish.reason.kind, 'stop')
  assert.strictEqual(probe.sawFinish, true)
})
checkAsync('finish_reason "length" becomes max-tokens, not stop', async () => {
  async function* source() {
    yield { choices: [{ delta: { content: 'cut off' }, finish_reason: 'length' }] }
  }
  const probe = { sawDone: false, sawFinish: false }
  const chunks = await collect(translateStream(source(), () => '{}', probe))
  const finish = chunks[chunks.length - 1]
  assert.strictEqual(finish.type, 'finish')
  assert.strictEqual(finish.reason.kind, 'max-tokens')
})
checkAsync('empty assistant/user messages never reach the wire', async () => {
  const wire = await serializeMessages([
    { role: 'system', content: 'be terse' },
    { role: 'user', content: [] },
    { role: 'assistant', content: [{ type: 'text', text: '' }, { type: 'reasoning', text: '' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'kept' }] },
    { role: 'user', content: [{ type: 'text', text: '' }] },
    { role: 'user', content: [{ type: 'text', text: 'next' }] },
  ], undefined, undefined)
  assert.deepStrictEqual(wire.map((m) => m.role), ['system', 'assistant', 'user'])
  assert.deepStrictEqual(wire.map((m) => m.content), ['be terse', 'kept', 'next'])
  // Empty turns would earn a hard 400 from a gateway that validates content.
  assert.ok(wire.every((m) => m.content !== '' && m.content.length > 0))
})
checkAsync('empty chat completion is EMPTY_RESPONSE', async () => {
  async function* source() { yield { choices: [{ delta: {}, finish_reason: 'stop' }] } }
  const probe = { sawDone: false, sawFinish: false }
  await assert.rejects(() => collect(translateStream(source(), () => '{}', probe)), (error) => error.code === 'EMPTY_RESPONSE')
})
checkAsync('Responses SSE fixture becomes harness blocks', async () => {
  // Shape observed against the live Zen wire 2026-10-02.
  async function* source() {
    yield { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } }
    yield { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', status: 'in_progress', summary: [] } }
    yield { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'pondering' }
    yield { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', status: 'completed' } }
    yield { type: 'response.output_item.added', output_index: 1, item: { type: 'message', status: 'in_progress', role: 'assistant', content: [] } }
    yield { type: 'response.output_text.delta', output_index: 1, delta: 'OK' }
    yield { type: 'response.output_item.done', output_index: 1, item: { type: 'message', status: 'completed' } }
    yield {
      type: 'response.completed',
      response: { status: 'completed', usage: { input_tokens: 9, input_tokens_details: { cached_tokens: 3 }, output_tokens: 5 } },
    }
    yield { type: 'ping', cost: '0' }
  }
  const probe = { sawDone: false, sawFinish: false }
  const chunks = await collect(translateResponsesStream(source(), () => '{}', probe))
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
  assert.strictEqual(text, 'OK')
  assert.strictEqual(reasoning, 'pondering')
  assert.strictEqual(chunks.find((c) => c.type === 'usage').usage.inputTokens, 6)
  assert.strictEqual(chunks[chunks.length - 1].reason.kind, 'stop')
  assert.strictEqual(probe.sawFinish, true)
})
checkAsync('Responses function-call flow yields a tool-call block', async () => {
  async function* source() {
    yield { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_9', name: 'bash', status: 'in_progress' } }
    yield { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"cmd":' }
    yield { type: 'response.function_call_arguments.delta', output_index: 0, delta: '"ls"}' }
    yield { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'call_9', name: 'bash', arguments: '{"cmd":"ls"}' } }
    yield { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } }
  }
  const chunks = await collect(translateResponsesStream(source(), () => '{}'))
  const end = chunks.find((c) => c.type === 'block-end' && c.block.type === 'tool-call')
  assert.ok(end, 'tool-call block must close')
  assert.strictEqual(end.block.id, 'call_9')
  assert.strictEqual(end.block.name, 'bash')
  assert.strictEqual(end.block.arguments, '{"cmd":"ls"}')
})
checkAsync('Responses failed event surfaces as SERVER', async () => {
  async function* source() { yield { type: 'response.failed', response: { error: { message: 'upstream exploded' } } } }
  await assert.rejects(
    () => collect(translateResponsesStream(source(), () => '{}')),
    (error) => error.code === 'SERVER' && error.message.includes('upstream exploded'),
  )
})

// ------------------------------------------------------------------ e2e wire

const scenario = { name: 'ok', hits: 0, headers: null, body: null, authLog: [] }

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

const server = http.createServer((req, res) => {
  scenario.hits += 1
  let raw = ''
  req.on('data', (chunk) => { raw += chunk })
  req.on('end', () => {
    scenario.headers = req.headers
    if (Array.isArray(scenario.authLog)) scenario.authLog.push(req.headers.authorization)
    try { scenario.body = JSON.parse(raw) } catch { scenario.body = raw }

    const isResponses = req.url.endsWith('/responses')
    if (scenario.name === 'unauthorized' && scenario.hits === 1) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end('{"error":{"message":"invalid api key"}}')
      return
    }
    if (scenario.name === 'daily429') {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7200' })
      res.end('{"type":"error","error":{"type":"FreeUsageLimitError","message":"Daily usage limit exceeded"}}')
      return
    }
    if (scenario.name === 'err401model') {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end('{"type":"error","error":{"type":"ModelError","message":"Model mimo-v2.6-flash-free is not supported"}}')
      return
    }
    if (scenario.name === 'err500') {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end('{"type":"error","error":{"type":"error","message":"Internal server error"}}')
      return
    }
    if (scenario.name === 'flaky' && scenario.hits === 1) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end('{"type":"error","error":{"type":"error","message":"Internal server error"}}')
      return
    }
    if (scenario.name === 'silent') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      return // headers only: the watchdog must kill the turn
    }
    if (scenario.name === 'destroy-early') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.socket.destroy()
      return
    }
    if (scenario.name === 'destroy-mid') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      sse(res, isResponses
        ? { type: 'response.output_text.delta', output_index: 0, delta: 'partial' }
        : { choices: [{ delta: { content: 'partial' } }] })
      setTimeout(() => res.socket.destroy(), 20)
      return
    }
    if (scenario.name === 'truncate-text') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      sse(res, isResponses
        ? { type: 'response.output_text.delta', output_index: 0, delta: 'partial' }
        : { choices: [{ delta: { content: 'partial' } }] })
      res.end() // clean EOF, no finish chunk, no [DONE]
      return
    }
    if (scenario.name === 'truncate-tool') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"pa' } }] } }] })
      res.end() // clean EOF mid tool call, args provably incomplete
      return
    }
    if (scenario.name === 'empty') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (!isResponses) sse(res, { choices: [{ delta: {}, finish_reason: 'stop' }] })
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    // default: happy path
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (isResponses) {
      sse(res, { type: 'response.output_item.added', output_index: 0, item: { type: 'message', status: 'in_progress', role: 'assistant', content: [] } })
      sse(res, { type: 'response.output_text.delta', output_index: 0, delta: 'muse ok' })
      sse(res, { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 7, output_tokens: 2 } } })
    } else {
      sse(res, { choices: [{ delta: { role: 'assistant' } }] })
      sse(res, { choices: [{ delta: { content: 'zen ok' } }] })
      sse(res, { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } })
    }
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

const messages = [
  { role: 'system', content: [{ type: 'text', text: 'be terse' }] },
  { role: 'user', content: [{ type: 'text', text: 'hello there' }] },
]

function baseOptions(overrides = {}) {
  return {
    provider: 'opencode',
    model: 'mimo-v2.6-flash-free',
    messages,
    system: 'be terse',
    tools: [{ name: 'read_file', description: 'read a file', parameters: { type: 'object', properties: {} } }],
    reasoningEffort: 'high',
    ...overrides,
  }
}

async function run() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  process.env.OPENCODE_ZEN_BASE = `http://127.0.0.1:${port}/v1`
  // Re-require with the base URL wired to the local server.
  delete require.cache[require.resolve('../lib/index.js')]
  const local = require('../lib/index.js')
  const localAdapter = new local.OpenCodeZenAdapter({ get: () => undefined, logger: { info() {}, warn() {} } })

  console.log('\n[6] end-to-end stream() against a local wire')

  scenario.name = 'ok'
  scenario.hits = 0
  await checkAsync('happy path yields blocks, usage, finish', async () => {
    const chunks = await collect(localAdapter.stream(baseOptions()))
    const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
    assert.strictEqual(text, 'zen ok')
    assert.strictEqual(chunks[chunks.length - 1].type, 'finish')
    assert.strictEqual(chunks.find((c) => c.type === 'usage').usage.outputTokens, 2)
  })
  check('request carried canonical session + CLI disguise headers', () => {
    assert.strictEqual(scenario.headers['x-opencode-client'], 'cli')
    assert.match(scenario.headers['x-opencode-session'], /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    // The CLI sends x-opencode-session-id unconditionally (request.ts).
    assert.strictEqual(scenario.headers['x-opencode-session-id'], scenario.headers['x-opencode-session'])
    assert.strictEqual(scenario.headers['x-session-affinity'], scenario.headers['x-opencode-session'])
    // The opencode lane's UA is the plain `opencode/<version>` (no platform
    // suffix), matching the real CLI's USER_AGENT byte for byte.
    assert.match(scenario.headers['user-agent'], /^opencode\/\d+\.\d+\.\d+$/)
    assert.strictEqual(scenario.headers.authorization, 'Bearer public')
  })
  check('request body is budget-clamped and gate-shaped', () => {
    assert.strictEqual(scenario.body.max_tokens, 32000, 'mimo output budget is 32k, never 128k')
    assert.strictEqual(scenario.body.reasoning_effort, 'high')
    const names = scenario.body.tools.map((t) => t.function.name)
    assert.ok(names.includes('bash') && names.includes('read'))
    assert.strictEqual(scenario.body.tool_choice, 'auto')
  })

  scenario.name = 'flaky'
  scenario.hits = 0
  await checkAsync('one 500 is retried in-process and recovers', async () => {
    const chunks = await collect(localAdapter.stream(baseOptions()))
    assert.strictEqual(chunks[chunks.length - 1].type, 'finish')
    assert.ok(scenario.hits >= 2, `expected a retry, hits=${scenario.hits}`)
  })

  scenario.name = 'err500'
  scenario.hits = 0
  await checkAsync('persistent 500 surfaces as typed SERVER for the host retry', async () => {
    await assert.rejects(
      () => collect(localAdapter.stream(baseOptions())),
      (error) => error.code === 'SERVER' && error.failure.status === 500 && error.message.includes('Internal server error'),
    )
    assert.strictEqual(scenario.hits, 2, 'exactly two in-process attempts')
  })

  scenario.name = 'silent'
  scenario.hits = 0
  await checkAsync('silent tunnel dies on the first-event watchdog as TIMEOUT', async () => {
    const started = Date.now()
    await assert.rejects(() => collect(localAdapter.stream(baseOptions())), (error) => error.code === 'TIMEOUT')
    const elapsed = Date.now() - started
    assert.ok(elapsed < 5000, `watchdog must fire quickly, took ${elapsed}ms`)
    assert.strictEqual(scenario.hits, 2, 'watchdog failure is retried once')
  })

  scenario.name = 'destroy-early'
  scenario.hits = 0
  await checkAsync('socket death before content is typed TRANSPORT and retried', async () => {
    await assert.rejects(() => collect(localAdapter.stream(baseOptions())), (error) => error.code === 'TRANSPORT')
    assert.strictEqual(scenario.hits, 2)
  })

  scenario.name = 'destroy-mid'
  scenario.hits = 0
  await checkAsync('socket death after content is never replayed', async () => {
    await assert.rejects(() => collect(localAdapter.stream(baseOptions())), (error) => error.code === 'TRANSPORT')
    assert.strictEqual(scenario.hits, 1, 'partial output must not be duplicated')
  })

  scenario.name = 'truncate-text'
  scenario.hits = 0
  await checkAsync('clean EOF after partial text commits a stop instead of failing the turn', async () => {
    const chunks = await collect(localAdapter.stream(baseOptions()))
    const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
    assert.strictEqual(text, 'partial')
    const finish = chunks[chunks.length - 1]
    assert.strictEqual(finish.type, 'finish')
    assert.strictEqual(finish.reason.kind, 'stop')
    assert.strictEqual(scenario.hits, 1, 'salvaged output must never be replayed')
  })

  scenario.name = 'truncate-tool'
  scenario.hits = 0
  await checkAsync('clean EOF mid tool call fails honestly instead of dispatching partial args', async () => {
    await assert.rejects(
      () => collect(localAdapter.stream(baseOptions())),
      (error) => error.code === 'STREAM_TRUNCATED' && error.message.includes('without a terminal event'),
    )
    assert.strictEqual(scenario.hits, 1, 'a stream with delivered content is never replayed')
  })

  scenario.name = 'empty'
  scenario.hits = 0
  await checkAsync('empty completion is EMPTY_RESPONSE and retried', async () => {
    await assert.rejects(() => collect(localAdapter.stream(baseOptions())), (error) => error.code === 'EMPTY_RESPONSE')
    assert.strictEqual(scenario.hits, 2)
  })

  scenario.name = 'daily429'
  scenario.hits = 0
  await checkAsync('long-window 429 surfaces at once without a futile in-process replay', async () => {
    await assert.rejects(
      () => collect(localAdapter.stream(baseOptions())),
      (error) => error.code === 'RATE_LIMIT' && error.message.includes('FreeUsageLimitError'),
    )
    assert.strictEqual(scenario.hits, 1, 'no point drawing a second 429 for a daily window')
  })

  scenario.name = 'err401model'
  scenario.hits = 0
  await checkAsync('401 ModelError fails fast as PROVIDER_ERROR with no key rotation', async () => {
    await assert.rejects(
      () => collect(localAdapter.stream(baseOptions())),
      (error) => error.code === 'PROVIDER_ERROR' && error.message.includes('does not serve this model'),
    )
    assert.strictEqual(scenario.hits, 1, 'a model gate is not credentials: no rotation, no replay')
  })

  scenario.name = 'ok'
  scenario.hits = 0
  await checkAsync('muse-spark routes through /responses with a Responses body', async () => {
    const chunks = await collect(localAdapter.stream(baseOptions({ model: 'muse-spark-1.3-contributor-free' })))
    const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
    assert.strictEqual(text, 'muse ok')
    assert.strictEqual(scenario.body.tool_choice, 'auto')
    assert.strictEqual(scenario.body.reasoning.effort, 'high')
    assert.ok(Array.isArray(scenario.body.input))
    assert.ok(!('messages' in scenario.body), 'Responses body must not carry chat messages')
    assert.strictEqual(scenario.body.max_output_tokens, 131072)
  })

  // --- key pool: 401 rotation and live reload -----------------------------
  const os = require('node:os')
  const fs = require('node:fs')
  const path = require('node:path')
  const poolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-pool-'))
  const poolFile = path.join(poolDir, 'pool.json')
  fs.writeFileSync(poolFile, JSON.stringify({ pools: { opencode: { keys: ['keyA', 'keyB'] } } }))
  process.env.OPENCODE_ZEN_POOL_FILE = poolFile
  delete require.cache[require.resolve('../lib/index.js')]
  const pooled = require('../lib/index.js')
  const pooledAdapter = new pooled.OpenCodeZenAdapter({ get: () => undefined, logger: { info() {}, warn() {} } })

  scenario.name = 'unauthorized'
  scenario.hits = 0
  scenario.authLog = []
  await checkAsync('401 rotates to the next pool key in-process', async () => {
    const chunks = await collect(pooledAdapter.stream(baseOptions()))
    assert.strictEqual(chunks[chunks.length - 1].type, 'finish')
    assert.strictEqual(scenario.hits, 2, 'one 401 plus one successful retry')
    assert.deepStrictEqual(scenario.authLog, ['Bearer keyA', 'Bearer keyB'])
  })

  await checkAsync('pool config edits are picked up without a restart', async () => {
    fs.writeFileSync(poolFile, JSON.stringify({ pools: { opencode: { keys: ['keyX'] } } }))
    const mtime = fs.statSync(poolFile).mtimeMs
    fs.utimesSync(poolFile, new Date(mtime + 5000), new Date(mtime + 5000))
    assert.strictEqual(pooled.resolveApiKey(), 'keyX')
  })
  delete process.env.OPENCODE_ZEN_POOL_FILE
  fs.rmSync(poolDir, { recursive: true, force: true })

  await runQuotaTests()

  await new Promise((resolve) => server.close(resolve))

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) {
    for (const item of failures) console.log(`  - ${item.label}: ${item.error.stack}`)
    process.exitCode = 1
  }
}

// --- quota accounting, address-family pinning, probes, status endpoint ---
async function runQuotaTests() {
  const os = require('node:os')
  const fs = require('node:fs')
  const path = require('node:path')
  const { createQuotaStore, dayKey, nextReset, normalizeFamily } = require('../lib/quota.js')
  const quotaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-quota-'))
  const quotaFile = path.join(quotaDir, 'quota.json')
  const day = Date.UTC(2026, 9, 2, 21, 0, 0)

  check('day key follows UTC, because the bucket rolls at 00:00 UTC', () => {
    assert.strictEqual(dayKey(day), '2026-10-02')
    assert.strictEqual(dayKey(Date.UTC(2026, 9, 2, 23, 59, 59)), '2026-10-02')
    assert.strictEqual(dayKey(Date.UTC(2026, 9, 3, 0, 0, 1)), '2026-10-03')
  })

  check('reset lands on the next UTC midnight', () => {
    assert.strictEqual(nextReset(Date.UTC(2026, 9, 2, 21, 0, 0)), Date.UTC(2026, 9, 3, 0, 0, 0))
    assert.strictEqual(nextReset(Date.UTC(2026, 9, 2, 23, 59, 59)), Date.UTC(2026, 9, 3, 0, 0, 0))
  })

  check('unknown family names collapse to auto', () => {
    assert.strictEqual(normalizeFamily('ipv4'), 'ipv4')
    assert.strictEqual(normalizeFamily('IPv6'), 'auto')
    assert.strictEqual(normalizeFamily(''), 'auto')
  })

  const store = createQuotaStore({ file: quotaFile, now: () => day })

  check('successful responses are counted per family, never pooled', () => {
    store.recordSuccess({ family: 'ipv4', model: 'big-pickle' })
    store.recordSuccess({ family: 'ipv4', model: 'big-pickle' })
    store.recordSuccess({ family: 'ipv6', model: 'mimo-v2.6-flash-free' })
    const snapshot = store.snapshot({ family: 'ipv4' })
    assert.strictEqual(snapshot.buckets.ipv4.ok, 2)
    assert.strictEqual(snapshot.buckets.ipv6.ok, 1)
    assert.strictEqual(snapshot.buckets.auto.ok, 0)
    assert.strictEqual(snapshot.buckets.ipv4.byModel['big-pickle'], 2)
  })

  check('the first 429 records a lower bound, never a fabricated limit', () => {
    store.recordDailyLimit({ family: 'ipv4', model: 'mimo-v2.5-free' })
    store.recordDailyLimit({ family: 'ipv4', model: 'mimo-v2.5-free' })
    const bucket = store.snapshot({ family: 'ipv4' }).buckets.ipv4
    assert.strictEqual(bucket.daily429, 2)
    assert.strictEqual(bucket.first429.ok, 2)
    assert.strictEqual(bucket.first429.model, 'mimo-v2.5-free')
  })

  check('counters survive a restart', () => {
    const reloaded = createQuotaStore({ file: quotaFile, now: () => day })
    assert.strictEqual(reloaded.snapshot({}).buckets.ipv4.ok, 2)
    assert.strictEqual(reloaded.snapshot({}).buckets.ipv6.ok, 1)
  })

  check('the family chosen in the panel survives a restart', () => {
    assert.strictEqual(store.getFamily(), 'auto')
    assert.strictEqual(store.setFamily('ipv6'), 'ipv6')
    assert.strictEqual(createQuotaStore({ file: quotaFile }).getFamily(), 'ipv6')
  })

  check('yesterday does not leak into today', () => {
    const rolloverFile = path.join(quotaDir, 'rollover.json')
    const fresh = createQuotaStore({ file: rolloverFile, now: () => day })
    fresh.recordSuccess({ family: 'ipv4', model: 'big-pickle' })
    const tomorrow = createQuotaStore({ file: rolloverFile, now: () => day + 86400000 })
    assert.strictEqual(tomorrow.snapshot({}).buckets.ipv4.ok, 0)
  })

  check('quota config defaults to auto family', () => {
    const config = plugin.resolveQuotaConfig({})
    assert.strictEqual(config.family, 'auto')
    assert.strictEqual(config.familyLocked, false)
  })

  check('an explicit config family locks the panel toggle', () => {
    const config = plugin.resolveQuotaConfig({ family: 'ipv4' })
    assert.strictEqual(config.family, 'ipv4')
    assert.strictEqual(config.familyLocked, true)
  })

  check('the env family outranks the stored panel choice', () => {
    process.env.DSH_ZEN_FAMILY = 'ipv6'
    try {
      assert.strictEqual(plugin.resolveQuotaConfig({}).family, 'ipv6')
      assert.strictEqual(plugin.resolveQuotaConfig({ family: 'ipv4' }).family, 'ipv6')
    } finally {
      delete process.env.DSH_ZEN_FAMILY
    }
  })

  await checkAsync('auto family never installs a dispatcher', async () => {
    const pool = plugin.createDispatcherPool({ Agent: class { close() {} } })
    assert.strictEqual(pool.for('auto'), undefined)
    await pool.close()
  })

  await checkAsync('ipv4 and ipv6 get separate pinned dispatchers', async () => {
    const created = []
    class Agent {
      constructor(options) { this.options = options; created.push(options) }
      async close() {}
    }
    const pool = plugin.createDispatcherPool({ Agent })
    const v4 = pool.for('ipv4')
    const v6 = pool.for('ipv6')
    assert.notStrictEqual(v4, undefined)
    assert.notStrictEqual(v6, undefined)
    assert.notStrictEqual(v4, v6, 'one Agent per family, never shared')
    assert.deepStrictEqual(created.map((options) => options.connect.family), [4, 6])
    assert.strictEqual(pool.for('ipv4'), v4, 'agents are reused, not rebuilt per request')
    await pool.close()
  })

  await checkAsync('a missing undici degrades to auto instead of throwing', async () => {
    const pool = plugin.createDispatcherPool(undefined)
    if (pool.available) {
      assert.notStrictEqual(pool.for('ipv4'), undefined, 'undici present: real Agent is built')
    } else {
      assert.strictEqual(pool.for('ipv4'), undefined)
    }
    await pool.close()
  })

  await checkAsync('toPlainFetchArgs flattens a foreign Request for undici.fetch', async () => {
    const [url, init] = plugin.toPlainFetchArgs(
      new Request('https://opencode.ai/zen/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"a":1}',
      }),
      undefined,
    )
    assert.strictEqual(url, 'https://opencode.ai/zen/v1/chat/completions')
    assert.strictEqual(init.method, 'POST')
    assert.strictEqual(new Headers(init.headers).get('content-type'), 'application/json')
    // Request bodies are streams; undici needs an explicit duplex flag for them
    assert.ok(init.body != null, 'body is carried over')
    assert.strictEqual(init.duplex, 'half')
    const [url2, init2] = plugin.toPlainFetchArgs('https://opencode.ai/zen/v1/x', { method: 'GET' })
    assert.strictEqual(url2, 'https://opencode.ai/zen/v1/x')
    assert.strictEqual(init2.method, 'GET')
  })

  await checkAsync('patchFetch routes pinned zen requests through the pooled fetch', async () => {
    const calls = []
    const dispatcher = { pinned: true }
    const patched = plugin.patchFetch(
      async () => { calls.push('original'); return new Response('{}', { status: 200 }) },
      { getStore: () => null },
      {
        dispatcherFor: () => dispatcher,
        dispatcherFetch: async (url, init) => { calls.push({ url, init }); return new Response('{}', { status: 200 }) },
      },
    )
    const zenUrl = `${plugin.OPENCODE_BASE}/chat/completions`
    await patched('https://example.com/v1/chat', { method: 'GET' })
    await patched(zenUrl, { method: 'POST', body: '{}' })
    assert.deepStrictEqual(calls.map((c) => (typeof c === 'string' ? c : 'pooled')), ['original', 'pooled'])
    assert.strictEqual(calls[1].url, zenUrl)
    assert.strictEqual(calls[1].init.dispatcher, dispatcher)
    // without a pooled fetch the patch degrades to the original fetch
    const degraded = plugin.patchFetch(
      async () => new Response('{}', { status: 200 }),
      { getStore: () => null },
      { dispatcherFor: () => dispatcher },
    )
    const ok = await degraded(zenUrl, { method: 'POST' })
    assert.strictEqual(ok.status, 200)
  })

  fs.rmSync(quotaDir, { recursive: true, force: true })
}

run().catch((error) => {
  console.error('test stand crashed:', error)
  process.exitCode = 1
})
