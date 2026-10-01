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
  httpFailure, ensureTyped, isResponsesModel,
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
})
check('HTTP 403 carries an actionable hint and stays non-retryable', () => {
  const gate = httpFailure(403, '{"type":"error","error":{"type":"FreeTierError","message":"x"}}')
  assert.strictEqual(gate.code, 'PROVIDER_ERROR')
  assert.ok(gate.failure.message.includes('canonical ses_ session'))
  const quota = httpFailure(403, '{"model":"mimo-v2.6-flash-free"}')
  assert.ok(quota.failure.message.includes('anonymous-lane refusal'))
  assert.ok(!('providerRetryAfterMs' in quota.failure))
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
checkAsync('providerRetryPolicy survives dsh-llm resolveRetryPolicy()', async () => {
  let dshLlm
  try { dshLlm = require(DSH_LLM) } catch (error) { console.log(`       (skipped, dsh-llm unavailable: ${error.message})`); return }
  const policy = adapter.providerRetryPolicy('opencode')
  const resolved = dshLlm.resolveRetryPolicy(policy, 'test')
  assert.strictEqual(resolved.mode, 'normal')
  assert.ok(resolved.retryableCodes.includes('SERVER'))
  assert.ok(resolved.retryableCodes.includes('RATE_LIMIT'))
  assert.ok(resolved.retryableCodes.includes('TRANSPORT'))
  assert.ok(resolved.retryableCodes.includes('EMPTY_RESPONSE'))
  assert.ok(!resolved.retryableCodes.includes('RATE_LIMITED'), 'the old bogus code must be gone')
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

const scenario = { name: 'ok', hits: 0, headers: null, body: null }

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

const server = http.createServer((req, res) => {
  scenario.hits += 1
  let raw = ''
  req.on('data', (chunk) => { raw += chunk })
  req.on('end', () => {
    scenario.headers = req.headers
    try { scenario.body = JSON.parse(raw) } catch { scenario.body = raw }

    const isResponses = req.url.endsWith('/responses')
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
    assert.strictEqual(scenario.headers['x-session-affinity'], scenario.headers['x-opencode-session'])
    assert.match(scenario.headers['user-agent'], /^opencode\//)
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

  scenario.name = 'empty'
  scenario.hits = 0
  await checkAsync('empty completion is EMPTY_RESPONSE and retried', async () => {
    await assert.rejects(() => collect(localAdapter.stream(baseOptions())), (error) => error.code === 'EMPTY_RESPONSE')
    assert.strictEqual(scenario.hits, 2)
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

  await new Promise((resolve) => server.close(resolve))

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) {
    for (const item of failures) console.log(`  - ${item.label}: ${item.error.stack}`)
    process.exitCode = 1
  }
}

run().catch((error) => {
  console.error('test stand crashed:', error)
  process.exitCode = 1
})
