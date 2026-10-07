'use strict'
/**
 * Contract tests for the thin dsh-opencode-zen adapter — Plan 3, Task 1.
 *
 * RED-first: these fixtures encode the binding contract BEFORE the thin
 * adapter exists (docs/superpowers/plans/2026-10-07-dsh-opencode-zen-thin.md
 * — mapping table lines 128-163 plus the Task 1-5 checkboxes). Tasks 2-6
 * flip them green group by group; nothing in this file stubs the
 * implementation.
 *
 * Contract anchors asserted throughout:
 *
 *   1. POST ${OPENCODE_ZEN_BASE}/v1/chat/completions (plan Task 3). Base HEAD
 *      defaults to the transport-proxy `http://127.0.0.1:8787/zen/v1` and
 *      posts `/chat/completions`, so every daemon-reachable row fails the
 *      path assertion first — that mismatch IS the Task-1 RED vehicle
 *      (task-1-brief (d)). A 428 guard answers any non-contract path, and
 *      428 collides with no mapping-table row, so rows can never pass by
 *      coincidence.
 *   2. Every thrown failure owns BOTH an own `code` AND an own
 *      `failure = {message, code, status?, providerRetryAfterMs?}` with both
 *      codes agreeing. A bare `err.code` degrades to UNKNOWN in host
 *      normalizeLlmFailure and is never retried (parity installed at
 *      lib/index.js:752-758), so every row asserts the pair plus the host's
 *      own normalize result.
 *   3. StreamChunk sequences: block-start → deltas* → block-end → usage →
 *      finish; usage before the terminal finish; exactly one finish; nothing
 *      after it (dsh-llm types.d.ts StreamChunk union).
 *
 * The fake daemon binds 127.0.0.1 only — no opencode.ai traffic. Zero new
 * deps; the runner contract is unchanged (npm test → node test/smoke.cjs).
 *
 * ~/.dsh isolation: the plugin resolves its pool file from $DSH_HOME and its
 * quota store from $DSH_HOME/state/... unless overridden. Both are pinned
 * into a temp dir BEFORE ../lib/index.js is first required, and apply()
 * receives config.quotaFile — this suite never reads or writes ~/.dsh.
 * apply()'s ctx.effect factories are recorded but never executed, so the
 * base implementation's globalThis.fetch patch stays dormant (Task 6 owns
 * apply()-side tests).
 *
 * Run: node test/smoke.cjs
 */

const assert = require('node:assert')
const http = require('node:http')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

// Host pins live in the immutable nix store — read-only, never assumed.
const DSH_LIB = '/nix/store/qph9ndg6jv1q0gd819j7am0h7nhs8kpy-dsh-0.2.0-rc.2/lib/node_modules/@deepseek-ai/dsh'

// Plan Task 3 transport contract: OPENCODE_ZEN_BASE carries NO path; the
// adapter appends CONTRACT_PATH itself.
const CONTRACT_PATH = '/v1/chat/completions'
const TEST_PROVIDER = 'opencode'
const TEST_MODEL = 'mimo-v2.6-flash-free'

// --- ~/.dsh isolation: must happen before the first require of ../lib ------
const TEST_TMP = mkdtempSync(join(tmpdir(), 'dsh-opencode-zen-task1-'))
if (!TEST_TMP.startsWith(tmpdir() + '/')) throw new Error(`refusing to operate outside the system temp dir: ${TEST_TMP}`)
process.env.OPENCODE_ZEN_POOL_FILE = join(TEST_TMP, 'pool-config.json')
const QUOTA_FILE = join(TEST_TMP, 'quota.json')

// ---------------------------------------------------------------- harness --
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

// ------------------------------------------------------------- host pins ---
let normalizeLlmFailure
try {
  const mod = require(join(DSH_LIB, 'node_modules/@deepseek-ai/dsh-llm/lib/types/adapter-failure.js'))
  normalizeLlmFailure = mod.normalizeLlmFailure ?? (mod.default && mod.default.normalizeLlmFailure)
} catch {
  normalizeLlmFailure = undefined
}

// --------------------------------------------------------- fake daemon -----
// Records the single observed request per test; scenario.name selects the
// canned response. Anything that is not POST /v1/chat/completions answers
// 428 (a status no mapping-table row claims), so a wrong path can never be
// mistaken for a green row.
const scenario = { name: 'ok', hits: 0, last: null }

function resetScenario(name) {
  scenario.name = name
  scenario.hits = 0
  scenario.last = null
}

const SSE_HEADERS = { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' }

function sse(res, payload) {
  res.write(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`)
}

function chunkFrame(res, delta, finishReason) {
  sse(res, {
    id: 'chatcmpl-fixture',
    object: 'chat.completion.chunk',
    created: 1728000000,
    model: TEST_MODEL,
    choices: [{ index: 0, delta, ...(finishReason ? { finish_reason: finishReason } : {}) }],
  })
}

function finishFrame(res, finishReason) {
  chunkFrame(res, {}, finishReason)
}

// The daemon emits usage as its own frame with an empty choices array, after
// the finish frame and before the single synthesized [DONE].
function usageFrame(res, usage) {
  sse(res, {
    id: 'chatcmpl-fixture',
    object: 'chat.completion.chunk',
    created: 1728000000,
    model: TEST_MODEL,
    choices: [],
    usage,
  })
}

function envelope(type, message) {
  const error = { message }
  if (type !== undefined) {
    // Client-facing error envelope (zen-router spec §5): error.code MIRRORS
    // error.type, and the {"type":"error"} wrapper never reaches clients.
    error.type = type
    error.code = type
  }
  return { error }
}

// On 429 the daemon always emits a TOP-LEVEL `metadata` sibling ({} when it
// has nothing to say); no other status carries it.
function withMetadata(body) {
  return { ...body, metadata: {} }
}

// One fixture per mapping-table HTTP row (plan lines 128-163), faithful to
// the daemon wire: envelope + top-level metadata on 429 + Retry-After in
// WHOLE SECONDS, only on 429.
const HTTP_ERRORS = {
  // Row 1 / row 2 — 401 (type decides; ModelError must NOT become a key
  // rotation).
  '401-model': { status: 401, body: envelope('ModelError', 'model not found') },
  '401-auth': { status: 401, body: envelope('AuthError', 'invalid api key') },
  '401-credits': { status: 401, body: envelope('CreditsError', 'out of credits') },
  '401-monthly': { status: 401, body: envelope('MonthlyLimitError', 'monthly limit reached') },
  '401-user': { status: 401, body: envelope('UserLimitError', 'user limit reached') },
  '401-bare': { status: 401, body: { error: { message: 'unauthorized' } } },
  // Row 3 — daily-limit 429 types → QUOTA (type-first precedence).
  '429-free': { status: 429, retryAfter: 7200, body: { ...envelope('FreeUsageLimitError', 'free usage limit'), metadata: { workspace: 'ws_fixture' } } },
  '429-go': { status: 429, retryAfter: 7200, body: withMetadata(envelope('GoUsageLimitError', 'go usage limit')) },
  '429-black': { status: 429, retryAfter: 7200, body: withMetadata(envelope('BlackUsageLimitError', 'black usage limit')) },
  // Row 4 — every other 429 → RATE_LIMIT + providerRetryAfterMs when the
  // header is present. The bare-429 fixture carries the type the daemon's
  // kindByStatus catch-all assigns (InvalidRequestError) and NO Retry-After
  // (the daemon only sets it when the upstream deadline is known).
  '429-ratelimit': { status: 429, retryAfter: 30, body: withMetadata(envelope('RateLimitError', 'rate limited')) },
  '429-catchall': { status: 429, body: withMetadata(envelope('InvalidRequestError', 'rate limited (untyped upstream)')) },
  '429-other': { status: 429, retryAfter: 5, body: withMetadata(envelope('SurpriseError', 'unexpected 429 class')) },
  // Row 5 — region/policy 403s.
  '403-region': { status: 403, body: envelope('RegionError', 'region blocked') },
  '403-datapolicy': { status: 403, body: envelope('DataPolicyError', 'data policy rejection') },
  // Row 6 — 404 / 405.
  '404-notfound': { status: 404, body: envelope('NotFoundError', 'route missing') },
  '405-method': { status: 405, body: envelope('MethodNotAllowedError', 'method not allowed') },
  // Row 7 — 400 InvalidRequestError.
  '400-invalid': { status: 400, body: envelope('InvalidRequestError', 'bad request') },
  // Row 8 — 413 payload cap.
  '413-payload': { status: 413, body: envelope('PayloadTooLargeError', 'request body over 4 MiB') },
  // Row 9 — ≥5xx → SERVER (typed, bare, transport, relay).
  '500-server': { status: 500, body: envelope('ServerError', 'upstream 500') },
  '500-bare': { status: 500, body: { error: { message: 'internal server error' } } },
  '502-transport': { status: 502, body: envelope('TransportError', 'upstream relay failed') },
  '503-internal': { status: 503, body: envelope('InternalError', 'upstream 503') },
  // Row 11 — unmatched statuses (unreachable per spec §9, but the safety
  // default must hold): wrong status never matches a row even when the type
  // does, and a free-tier 403 is not a region/policy 403.
  '402-unmatched': { status: 402, body: envelope('PaymentRequiredError', 'unreachable per spec §9') },
  '418-unmatched': { status: 418, body: envelope('InvalidRequestError', 'row type at the wrong status') },
  '403-freetier': { status: 403, body: envelope('FreeTierError', 'free-tier gate, not region/policy') },
}

// Stream-outcome fixtures (rows 13-15) plus the happy path (Task 4).
const STREAMS = {
  // Happy: role → content* → finish frame → usage frame → single [DONE].
  ok(res) {
    res.writeHead(200, SSE_HEADERS)
    chunkFrame(res, { role: 'assistant' })
    chunkFrame(res, { content: 'Hello' })
    chunkFrame(res, { content: ' world' })
    finishFrame(res, 'stop')
    usageFrame(res, { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10, prompt_tokens_details: { cached_tokens: 2 } })
    sse(res, '[DONE]')
    res.end()
  },
  // Reasoning + text + a tool call. The daemon never emits
  // finish_reason:"tool_calls" (its finish frame carries stop/length only),
  // so the finish here is "stop" like every other completed stream; the tool
  // metadata chunk carries id + type + function name, later fragments carry
  // argument slices.
  multi(res) {
    res.writeHead(200, SSE_HEADERS)
    chunkFrame(res, { role: 'assistant' })
    chunkFrame(res, { reasoning_content: 'think hard' })
    chunkFrame(res, { reasoning_content: ' more' })
    chunkFrame(res, { content: 'answer' })
    chunkFrame(res, { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file' } }] })
    chunkFrame(res, { tool_calls: [{ index: 0, function: { arguments: '{"path"' } }] })
    chunkFrame(res, { tool_calls: [{ index: 0, function: { arguments: ':"a"}' } }] })
    finishFrame(res, 'stop')
    usageFrame(res, { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 })
    sse(res, '[DONE]')
    res.end()
  },
  // Comments, event: lines, an oa-compat cost frame and a ping cost frame
  // must all be ignored (Task 4 checkbox); the usage frame must still land.
  comments(res) {
    res.writeHead(200, SSE_HEADERS)
    res.write(': keep-alive comment\n\n')
    res.write('event: custom\n\n')
    sse(res, { type: 'ping', cost: 0.004 })
    sse(res, { choices: [], cost: 0.42 })
    chunkFrame(res, { role: 'assistant' })
    chunkFrame(res, { content: 'Hello' })
    finishFrame(res, 'stop')
    usageFrame(res, { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 })
    sse(res, '[DONE]')
    res.end()
  },
  // Row 13 — stream death BEFORE any content (headers + a comment, then the
  // socket dies) → TIMEOUT.
  'kill-precontent'(req, res) {
    res.writeHead(200, SSE_HEADERS)
    res.write(': prime\n\n')
    const timer = setTimeout(() => { res.socket.destroy() }, 120)
    res.on('close', () => clearTimeout(timer))
  },
  // Row 15 — premature close AFTER content, abnormal EOF.
  'kill-after-content'(req, res) {
    res.writeHead(200, SSE_HEADERS)
    chunkFrame(res, { role: 'assistant' })
    chunkFrame(res, { content: 'partial' })
    const timer = setTimeout(() => { res.socket.destroy() }, 80)
    res.on('close', () => clearTimeout(timer))
  },
  // Row 15 — premature close AFTER content, clean FIN with [DONE] missing.
  'clean-end-after-content'(req, res) {
    res.writeHead(200, SSE_HEADERS)
    chunkFrame(res, { role: 'assistant' })
    chunkFrame(res, { content: 'partial' })
    res.end()
  },
  // Delivers one content chunk immediately; the tail (more content, finish,
  // usage, [DONE]) lands 400 ms later — used by the mid-flight abort row.
  slow(req, res) {
    res.writeHead(200, SSE_HEADERS)
    chunkFrame(res, { role: 'assistant' })
    chunkFrame(res, { content: 'first' })
    const timer = setTimeout(() => {
      chunkFrame(res, { content: ' second' })
      finishFrame(res, 'stop')
      usageFrame(res, { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 })
      sse(res, '[DONE]')
      res.end()
    }, 400)
    res.on('close', () => clearTimeout(timer))
  },
  // Row 14 — clean [DONE] termination with zero content → EMPTY_RESPONSE.
  'zero-done'(res) {
    res.writeHead(200, SSE_HEADERS)
    sse(res, '[DONE]')
    res.end()
  },
  // Row 14 — clean end (finish + usage, no [DONE]) with zero content →
  // EMPTY_RESPONSE. The daemon itself refuses to tail a block-less stream;
  // the adapter must still classify this wire as EMPTY_RESPONSE.
  'zero-end'(res) {
    res.writeHead(200, SSE_HEADERS)
    finishFrame(res, 'stop')
    usageFrame(res, { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 })
    res.end()
  },
  // Row 10 — socket dies before any status line reaches the client.
  'reset-preheaders'(req, res) {
    res.socket.destroy()
  },
}

const server = http.createServer((req, res) => {
  res.on('error', () => {})
  let raw = ''
  req.on('data', (piece) => { raw += piece })
  req.on('end', () => {
    scenario.hits += 1
    let body = null
    try { body = raw ? JSON.parse(raw) : null } catch { body = null }
    scenario.last = { method: req.method, path: req.url, headers: req.headers, body }

    const guard = (message) => {
      res.writeHead(428, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `test guard: ${message}`, type: 'InvalidRequestError', code: 'InvalidRequestError' } }))
    }
    if (req.url !== CONTRACT_PATH) {
      return guard(`unexpected ${req.method} ${req.url}; the plan contract is POST ${CONTRACT_PATH}`)
    }
    if (req.method !== 'POST') {
      return guard(`unexpected ${req.method} on ${CONTRACT_PATH}; the plan contract is POST ${CONTRACT_PATH}`)
    }
    const httpError = HTTP_ERRORS[scenario.name]
    if (httpError) {
      const headers = { 'content-type': 'application/json' }
      if (httpError.retryAfter !== undefined) headers['retry-after'] = String(httpError.retryAfter)
      res.writeHead(httpError.status, headers)
      res.end(JSON.stringify(httpError.body))
      return
    }
    const stream = STREAMS[scenario.name]
    if (stream) return stream(req, res)
    return guard(`unknown scenario "${scenario.name}"`)
  })
})

function listen(target) {
  return new Promise((resolve, reject) => {
    target.once('error', reject)
    target.listen(0, '127.0.0.1', () => {
      target.removeListener('error', reject)
      resolve()
    })
  })
}

// Bind then close: the port is real but nothing listens — connection refused.
async function closedPort() {
  const probe = http.createServer()
  await listen(probe)
  const { port } = probe.address()
  await new Promise((resolve) => probe.close(resolve))
  return port
}

// ---------------------------------------------------------- adapter load --
// Each load re-reads OPENCODE_ZEN_BASE at module load (the base HEAD bakes
// the transport-proxy default into a module-level const). The URL carries NO
// path: OPENCODE_ZEN_BASE=http://127.0.0.1:<port>, the daemon serves
// CONTRACT_PATH itself.
function makeCtx() {
  const registrations = []
  const effectFactories = []
  return {
    registrations,
    effectFactories,
    llm: { registerAdapter(routes, adapter) { registrations.push({ routes, adapter }) } },
    logger: { info() {}, warn() {}, error() {} },
    // cordis effects install side effects — the base implementation patches
    // globalThis.fetch through ctx.effect. Record the factory and never run
    // it: every check stays hermetic and ~/.dsh-facing setup stays dormant
    // (Task 6 owns apply()-side behavior).
    effect(factory) { effectFactories.push(factory) },
    on() {},
    get() { return undefined },
  }
}

function loadAdapter(baseUrl) {
  process.env.OPENCODE_ZEN_BASE = baseUrl
  delete require.cache[require.resolve('../lib/index.js')]
  const plugin = require('../lib/index.js')
  assert.strictEqual(typeof plugin.apply, 'function', "the plugin must export cordis's apply(ctx, config)")
  const ctx = makeCtx()
  plugin.apply(ctx, { quotaFile: QUOTA_FILE })
  assert.strictEqual(ctx.registrations.length, 1, 'apply() must register exactly one adapter via ctx.llm.registerAdapter')
  const registration = ctx.registrations[0]
  assert.deepStrictEqual(registration.routes, [TEST_PROVIDER], "apply() must register routes ['opencode']")
  assert.ok(registration.adapter && typeof registration.adapter.stream === 'function', 'the registered value must expose stream(options)')
  return { plugin, adapter: registration.adapter, ctx }
}

// --------------------------------------------------------------- helpers ---
function baseOptions(overrides = {}) {
  return {
    provider: TEST_PROVIDER,
    model: TEST_MODEL,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'contract test' }] }],
    system: 'Be terse.',
    ...overrides,
  }
}

// Drive the stream to completion, keeping the chunks yielded before a throw.
async function attempt(adapter, options) {
  const chunks = []
  let error = null
  try {
    const iterator = adapter.stream(options)[Symbol.asyncIterator]()
    for (;;) {
      const step = await iterator.next()
      if (step.done) break
      chunks.push(step.value)
    }
  } catch (err) {
    error = err
  }
  return { chunks, error }
}

function assertContractRequest() {
  const request = scenario.last
  assert.ok(request, 'the fixture daemon received no request — the adapter must POST the contract path')
  assert.strictEqual(request.path, CONTRACT_PATH, `plan Task 3 contract: POST ${CONTRACT_PATH}; got ${request.method} ${request.path}`)
  assert.strictEqual(request.method, 'POST', `plan Task 3 contract: POST ${CONTRACT_PATH}; got ${request.method} ${request.path}`)
}

function assertSingleRequest() {
  assert.strictEqual(scenario.hits, 1, 'exactly one attempt — the thin adapter must not retry in-process (plan Global Constraints)')
}

// Row contract for every thrown failure: own `code` + own `failure` snapshot
// agreeing, status/providerRetryAfterMs exactly as the row prescribes, and a
// host normalizeLlmFailure pass (the bare-code → UNKNOWN trap).
function assertFailureSnapshot(error, expect) {
  assert.ok(error && typeof error === 'object', `expected a thrown failure (code ${expect.code}); got ${String(error)}`)
  const codeDesc = Object.getOwnPropertyDescriptor(error, 'code')
  assert.ok(codeDesc && typeof codeDesc.value === 'string' && codeDesc.value.length > 0,
    'the failure must OWN a non-empty string `code` data property (a bare or inherited code degrades to UNKNOWN in host normalizeLlmFailure)')
  const failureDesc = Object.getOwnPropertyDescriptor(error, 'failure')
  assert.ok(failureDesc && failureDesc.value && typeof failureDesc.value === 'object' && !Array.isArray(failureDesc.value),
    'the failure must OWN a `failure` snapshot object (parity: typedError installs both props, lib/index.js:752-758)')
  const failure = failureDesc.value
  assert.ok(typeof failure.message === 'string' && failure.message.length > 0, 'failure.message is a non-empty string')
  assert.strictEqual(failure.code, expect.code, `failure.code is ${expect.code}`)
  assert.strictEqual(failure.code, codeDesc.value, 'failure.code agrees with the own err.code')
  assert.strictEqual(codeDesc.value, expect.code, `own err.code is ${expect.code}`)
  if ('status' in expect) {
    if (expect.status === 'absent') {
      assert.strictEqual(failure.status, undefined, 'failure.status must be absent (no HTTP response was observed)')
    } else {
      assert.strictEqual(failure.status, expect.status, `failure.status is ${expect.status}`)
    }
  }
  const expectedRetry = expect.retryAfterMs === 'absent' ? undefined : expect.retryAfterMs
  assert.strictEqual(failure.providerRetryAfterMs, expectedRetry,
    expect.retryAfterMs === 'absent'
      ? 'providerRetryAfterMs must be absent (the fixture sent no Retry-After)'
      : `providerRetryAfterMs is ${expect.retryAfterMs} (Retry-After whole seconds × 1000)`)
  if (typeof normalizeLlmFailure === 'function') {
    const normalized = normalizeLlmFailure(error)
    assert.strictEqual(normalized.code, expect.code,
      'host normalizeLlmFailure keeps the snapshot (an unpaired code would degrade to UNKNOWN)')
    if ('status' in expect && expect.status !== 'absent') {
      assert.strictEqual(normalized.status, expect.status, 'the normalized snapshot keeps status')
    }
    if (expectedRetry !== undefined) {
      assert.strictEqual(normalized.providerRetryAfterMs, expectedRetry, 'the normalized snapshot keeps providerRetryAfterMs')
    }
  }
}

// One mapping-table row: run the scenario, assert the contract request, then
// the thrown failure's snapshot.
async function expectRow(adapter, label, options) {
  await checkAsync(label, async () => {
    resetScenario(options.scenarioName)
    const { chunks, error } = await attempt(adapter, baseOptions())
    if (options.request !== false) {
      assertContractRequest()
      assertSingleRequest()
    }
    assert.ok(error,
      `expected a thrown failure with code ${options.expected.code}; stream yielded: ${chunks.map((c) => c.type).join(' → ') || '(no chunks)'}`)
    assertFailureSnapshot(error, options.expected)
    if (Array.isArray(options.chunks)) {
      assert.deepStrictEqual(chunks.map((c) => c.type), options.chunks,
        'this outcome must not yield any StreamChunk')
    }
  })
}

function assertExactDefinedKeys(obj, expected, what) {
  const keys = Object.keys(obj).filter((key) => obj[key] !== undefined).sort()
  assert.deepStrictEqual(keys, [...expected].sort(), `${what}: unexpected keys ${JSON.stringify(Object.keys(obj))}`)
}

// ------------------------------------------------------------------- run ---
async function run() {
  // Every fixture answers within ~400 ms. The base HEAD's in-process retry
  // loop (MAX_REQUEST_ATTEMPTS = 2) adds at most one 15 s RATE_LIMIT sleep
  // per row, so 300 s is a generous ceiling that still catches a hang.
  const watchdog = setTimeout(() => {
    console.error('FATAL: test stand exceeded the 300s watchdog')
    process.exit(1)
  }, 300000)
  watchdog.unref()

  await listen(server)
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const fixture = loadAdapter(baseUrl)
  const adapter = fixture.adapter

  console.log('\n[host pins]')

  check("[host] normalizeLlmFailure keeps agreed code+failure pairs and degrades bare codes to UNKNOWN", () => {
    assert.strictEqual(typeof normalizeLlmFailure, 'function',
      `normalizeLlmFailure must load from ${DSH_LIB}/node_modules/@deepseek-ai/dsh-llm/lib/types/adapter-failure.js`)
    const paired = new Error('upstream 500')
    paired.code = 'SERVER'
    paired.failure = { message: 'upstream 500', code: 'SERVER', status: 500 }
    assert.strictEqual(normalizeLlmFailure(paired).code, 'SERVER')
    const bare = new Error('upstream 500')
    assert.strictEqual(normalizeLlmFailure(bare).code, 'UNKNOWN',
      'a bare err.code degrades to UNKNOWN — that is why every row asserts the own-code + failure pair')
    const disagreeing = new Error('upstream 500')
    disagreeing.code = 'RATE_LIMIT'
    disagreeing.failure = { message: 'upstream 500', code: 'SERVER', status: 503 }
    assert.strictEqual(normalizeLlmFailure(disagreeing).code, 'UNKNOWN',
      'the snapshot is trusted only when failure.code agrees with the own code')
  })

  check("[host] dsh-llm *_CODE constants match the strings this suite asserts (nix-store pin)", () => {
    const llm = require(join(DSH_LIB, 'node_modules/@deepseek-ai/dsh-llm/lib/index.js'))
    assert.strictEqual(llm.QUOTA_EXCEEDED_CODE, 'QUOTA')
    assert.strictEqual(llm.EMPTY_RESPONSE_CODE, 'EMPTY_RESPONSE')
    assert.strictEqual(llm.INVALID_CREDENTIAL_CODE, 'INVALID_CREDENTIAL')
  })

  console.log('\n[Task 3 — transport contract]')

  await checkAsync('plan Task 3: stream() POSTs /v1/chat/completions (base HEAD posts the transport-proxy path instead)', async () => {
    resetScenario('ok')
    const { error } = await attempt(adapter, baseOptions())
    assertContractRequest()
    if (error) assert.fail(`expected the happy stream to reach content, got ${error.code || error.message}`)
    assertSingleRequest()
  })

  console.log('\n[Task 4 — SSE translator]')

  await checkAsync('[Task 4] happy path: block-start → text-delta* → block-end → usage → finish (exact sequence)', async () => {
    resetScenario('ok')
    const { chunks, error } = await attempt(adapter, baseOptions())
    assertContractRequest()
    if (error) assert.fail(`expected no failure, got ${error.code || error.message}`)
    assert.deepStrictEqual(chunks.map((c) => c.type),
      ['block-start', 'text-delta', 'text-delta', 'block-end', 'usage', 'finish'])
    assert.deepStrictEqual(chunks[0], { type: 'block-start', index: 0, blockType: 'text' })
    assert.deepStrictEqual(chunks[1], { type: 'text-delta', index: 0, text: 'Hello' })
    assert.deepStrictEqual(chunks[2], { type: 'text-delta', index: 0, text: ' world' })
    assert.deepStrictEqual(chunks[3], { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello world' } })
    // prompt_tokens 7 minus cached_tokens 2; total_tokens preserved as the
    // provider sent it (dsh-llm types.d.ts: counters are disjoint, totals
    // are preserved when available).
    assert.deepStrictEqual(chunks[4].usage,
      { inputTokens: 5, outputTokens: 3, totalTokens: 10, cacheReadTokens: 2 })
    assert.strictEqual(chunks[5].type, 'finish')
    assert.deepStrictEqual(chunks[5].reason, { kind: 'stop' })
    assertSingleRequest()
  })

  await checkAsync('[Task 4] reasoning + text + tool blocks pair block-start/block-end; tool id/name/argument deltas assemble', async () => {
    resetScenario('multi')
    const { chunks, error } = await attempt(adapter, baseOptions())
    assertContractRequest()
    if (error) assert.fail(`expected no failure, got ${error.code || error.message}`)
    assert.deepStrictEqual(chunks.map((c) => c.type), [
      'block-start', 'reasoning-delta', 'reasoning-delta', 'block-end',
      'block-start', 'text-delta', 'block-end',
      'block-start', 'tool-call-delta', 'tool-call-delta', 'tool-call-delta', 'block-end',
      'usage', 'finish',
    ])
    assert.deepStrictEqual(
      chunks.filter((c) => c.type === 'block-start').map((c) => c.blockType),
      ['reasoning', 'text', 'tool-call'])
    assert.strictEqual(chunks[1].text, 'think hard')
    assert.strictEqual(chunks[2].text, ' more')
    assert.deepStrictEqual(chunks[3], { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'think hard more' } })
    assert.deepStrictEqual(chunks[5], { type: 'text-delta', index: 1, text: 'answer' })
    assert.deepStrictEqual(chunks[6], { type: 'block-end', index: 1, block: { type: 'text', text: 'answer' } })
    const toolDeltas = chunks.filter((c) => c.type === 'tool-call-delta')
    assert.strictEqual(toolDeltas.length, 3, 'the tool metadata chunk and both argument fragments each yield a tool-call-delta')
    assert.strictEqual(toolDeltas[0].id, 'call_1', 'the metadata chunk carries the tool id')
    assert.strictEqual(toolDeltas[0].name, 'read_file', 'the metadata chunk carries the tool name')
    assert.strictEqual(toolDeltas.map((d) => d.argumentsDelta).join(''), '{"path":"a"}')
    for (const delta of toolDeltas) assert.strictEqual(delta.index, 2, 'every tool delta uses the tool block index')
    assert.deepStrictEqual(chunks[11], {
      type: 'block-end', index: 2,
      block: { type: 'tool-call', id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' },
    })
    const usage = chunks[12].usage
    assert.deepStrictEqual(usage, { inputTokens: 4, outputTokens: 6, totalTokens: 10 })
    assert.strictEqual(chunks[13].type, 'finish')
    assert.deepStrictEqual(chunks[13].reason, { kind: 'stop' })
    assertSingleRequest()
  })

  await checkAsync('[Task 4] comment / event / cost / ping lines are ignored; the usage frame still lands', async () => {
    resetScenario('comments')
    const { chunks, error } = await attempt(adapter, baseOptions())
    assertContractRequest()
    if (error) assert.fail(`expected no failure, got ${error.code || error.message}`)
    assert.deepStrictEqual(chunks.map((c) => c.type),
      ['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
    assert.deepStrictEqual(chunks[3].usage, { inputTokens: 3, outputTokens: 1, totalTokens: 4 })
    assertExactDefinedKeys(chunks[3].usage, ['inputTokens', 'outputTokens', 'totalTokens'], 'usage')
    assert.deepStrictEqual(chunks[4].reason, { kind: 'stop' })
    assertSingleRequest()
  })

  await checkAsync('row 15: EOF AFTER content (socket death) → salvage closes the open block, then one finish', async () => {
    resetScenario('kill-after-content')
    const { chunks, error } = await attempt(adapter, baseOptions())
    assertContractRequest()
    if (error) assert.fail(`salvage must not throw (plan row 15): got ${error.code || error.message}: ${error.message}`)
    assert.deepStrictEqual(chunks.map((c) => c.type), ['block-start', 'text-delta', 'block-end', 'finish'])
    assert.deepStrictEqual(chunks[2], { type: 'block-end', index: 0, block: { type: 'text', text: 'partial' } })
    assert.strictEqual(chunks[3].type, 'finish')
    assert.deepStrictEqual(chunks[3].reason, { kind: 'stop' }, 'salvage terminates with a stop finish')
    assertSingleRequest()
  })

  await checkAsync('row 15: EOF AFTER content (clean end, [DONE] missing) → salvage closes the open block, then one finish', async () => {
    resetScenario('clean-end-after-content')
    const { chunks, error } = await attempt(adapter, baseOptions())
    assertContractRequest()
    if (error) assert.fail(`salvage must not throw (plan row 15): got ${error.code || error.message}: ${error.message}`)
    assert.deepStrictEqual(chunks.map((c) => c.type), ['block-start', 'text-delta', 'block-end', 'finish'])
    assert.deepStrictEqual(chunks[2], { type: 'block-end', index: 0, block: { type: 'text', text: 'partial' } })
    assert.deepStrictEqual(chunks[3].reason, { kind: 'stop' })
    assertSingleRequest()
  })

  console.log('\n[Task 5 — mapping table]')

  await expectRow(adapter, 'row 1: 401 + ModelError → PROVIDER_ERROR (the 401 trap; never a key rotation)', {
    scenarioName: '401-model', expected: { code: 'PROVIDER_ERROR', status: 401, retryAfterMs: 'absent' },
  })
  await expectRow(adapter, 'row 2: 401 + AuthError → INVALID_CREDENTIAL', {
    scenarioName: '401-auth', expected: { code: 'INVALID_CREDENTIAL', status: 401, retryAfterMs: 'absent' },
  })
  await expectRow(adapter, 'row 2: 401 + CreditsError → INVALID_CREDENTIAL', {
    scenarioName: '401-credits', expected: { code: 'INVALID_CREDENTIAL', status: 401, retryAfterMs: 'absent' },
  })
  await expectRow(adapter, 'row 2: 401 + MonthlyLimitError → INVALID_CREDENTIAL', {
    scenarioName: '401-monthly', expected: { code: 'INVALID_CREDENTIAL', status: 401, retryAfterMs: 'absent' },
  })
  await expectRow(adapter, 'row 2: 401 + UserLimitError → INVALID_CREDENTIAL', {
    scenarioName: '401-user', expected: { code: 'INVALID_CREDENTIAL', status: 401, retryAfterMs: 'absent' },
  })
  await expectRow(adapter, 'row 2: bare 401 (no error.type) → INVALID_CREDENTIAL', {
    scenarioName: '401-bare', expected: { code: 'INVALID_CREDENTIAL', status: 401, retryAfterMs: 'absent' },
  })

  await expectRow(adapter, 'row 3: 429 + FreeUsageLimitError + Retry-After 7200 → QUOTA, providerRetryAfterMs 7200000', {
    scenarioName: '429-free', expected: { code: 'QUOTA', status: 429, retryAfterMs: 7200000 },
  })
  await expectRow(adapter, 'row 3: 429 + GoUsageLimitError + Retry-After 7200 → QUOTA, providerRetryAfterMs 7200000', {
    scenarioName: '429-go', expected: { code: 'QUOTA', status: 429, retryAfterMs: 7200000 },
  })
  await expectRow(adapter, 'row 3: 429 + BlackUsageLimitError + Retry-After 7200 → QUOTA, providerRetryAfterMs 7200000', {
    scenarioName: '429-black', expected: { code: 'QUOTA', status: 429, retryAfterMs: 7200000 },
  })
  await expectRow(adapter, 'row 4: 429 + RateLimitError + Retry-After 30 → RATE_LIMIT, providerRetryAfterMs 30000', {
    scenarioName: '429-ratelimit', expected: { code: 'RATE_LIMIT', status: 429, retryAfterMs: 30000 },
  })
  await expectRow(adapter, 'row 4: 429 bare-429 (InvalidRequestError catch-all), no Retry-After → RATE_LIMIT without providerRetryAfterMs', {
    scenarioName: '429-catchall', expected: { code: 'RATE_LIMIT', status: 429, retryAfterMs: 'absent' },
  })
  await expectRow(adapter, 'row 4: 429 any other type (SurpriseError) + Retry-After 5 → RATE_LIMIT, providerRetryAfterMs 5000', {
    scenarioName: '429-other', expected: { code: 'RATE_LIMIT', status: 429, retryAfterMs: 5000 },
  })

  await expectRow(adapter, 'row 5: 403 + RegionError → PROVIDER_ERROR', {
    scenarioName: '403-region', expected: { code: 'PROVIDER_ERROR', status: 403, retryAfterMs: 'absent' },
  })
  await expectRow(adapter, 'row 5: 403 + DataPolicyError → PROVIDER_ERROR', {
    scenarioName: '403-datapolicy', expected: { code: 'PROVIDER_ERROR', status: 403, retryAfterMs: 'absent' },
  })
  await expectRow(adapter, 'row 6: 404 + NotFoundError → PROVIDER_ERROR', {
    scenarioName: '404-notfound', expected: { code: 'PROVIDER_ERROR', status: 404, retryAfterMs: 'absent' },
  })
  await expectRow(adapter, 'row 6: 405 + MethodNotAllowedError → PROVIDER_ERROR', {
    scenarioName: '405-method', expected: { code: 'PROVIDER_ERROR', status: 405, retryAfterMs: 'absent' },
  })
  await expectRow(adapter, 'row 7: 400 + InvalidRequestError → PROVIDER_ERROR', {
    scenarioName: '400-invalid', expected: { code: 'PROVIDER_ERROR', status: 400, retryAfterMs: 'absent' },
  })
  await expectRow(adapter, 'row 8: 413 + PayloadTooLargeError → PROVIDER_ERROR', {
    scenarioName: '413-payload', expected: { code: 'PROVIDER_ERROR', status: 413, retryAfterMs: 'absent' },
  })

  await expectRow(adapter, 'row 9: 500 + ServerError → SERVER', {
    scenarioName: '500-server', expected: { code: 'SERVER', status: 500, retryAfterMs: 'absent' },
  })
  await expectRow(adapter, 'row 9: 500 bare (no error.type) → SERVER', {
    scenarioName: '500-bare', expected: { code: 'SERVER', status: 500, retryAfterMs: 'absent' },
  })
  await expectRow(adapter, 'row 9: 502 + TransportError → SERVER', {
    scenarioName: '502-transport', expected: { code: 'SERVER', status: 502, retryAfterMs: 'absent' },
  })
  await expectRow(adapter, 'row 9: 503 + InternalError → SERVER', {
    scenarioName: '503-internal', expected: { code: 'SERVER', status: 503, retryAfterMs: 'absent' },
  })

  await expectRow(adapter, 'row 11: 402 + PaymentRequiredError (unmatched status) → PROVIDER_ERROR safety default', {
    scenarioName: '402-unmatched', expected: { code: 'PROVIDER_ERROR', status: 402, retryAfterMs: 'absent' },
  })
  await expectRow(adapter, 'row 11: 418 + row type InvalidRequestError at the wrong status → PROVIDER_ERROR', {
    scenarioName: '418-unmatched', expected: { code: 'PROVIDER_ERROR', status: 418, retryAfterMs: 'absent' },
  })
  await expectRow(adapter, 'row 11: 403 + FreeTierError (not Region/DataPolicy) → PROVIDER_ERROR', {
    scenarioName: '403-freetier', expected: { code: 'PROVIDER_ERROR', status: 403, retryAfterMs: 'absent' },
  })

  console.log('\n[Task 5 — stream outcomes]')

  await expectRow(adapter, 'row 10: socket reset before the status line → TRANSPORT, no status, no replay', {
    scenarioName: 'reset-preheaders', expected: { code: 'TRANSPORT', status: 'absent', retryAfterMs: 'absent' }, chunks: [],
  })

  await checkAsync('row 12: host AbortSignal fired mid-flight → ABORTED, no status, no replay', async () => {
    resetScenario('slow')
    const controller = new AbortController()
    const chunks = []
    let error = null
    try {
      const iterator = adapter.stream(baseOptions({ signal: controller.signal }))[Symbol.asyncIterator]()
      for (;;) {
        const step = await iterator.next()
        if (step.done) break
        chunks.push(step.value)
        if (chunks.length === 1) controller.abort()
      }
    } catch (err) {
      error = err
    }
    assertContractRequest()
    assert.ok(chunks.length >= 1, 'the abort fires after the first chunk, and the fixture delivered it')
    assert.ok(error, 'aborting the host signal must reject the stream')
    assertFailureSnapshot(error, { code: 'ABORTED', status: 'absent', retryAfterMs: 'absent' })
    assertSingleRequest()
  })

  await expectRow(adapter, 'row 13: stream death BEFORE any content → TIMEOUT, no replay', {
    scenarioName: 'kill-precontent', expected: { code: 'TIMEOUT', retryAfterMs: 'absent' }, chunks: [],
  })
  await expectRow(adapter, 'row 14: clean [DONE] termination with zero content → EMPTY_RESPONSE', {
    scenarioName: 'zero-done', expected: { code: 'EMPTY_RESPONSE', retryAfterMs: 'absent' }, chunks: [],
  })
  await expectRow(adapter, 'row 14: clean end (no [DONE]) with zero content → EMPTY_RESPONSE', {
    scenarioName: 'zero-end', expected: { code: 'EMPTY_RESPONSE', retryAfterMs: 'absent' }, chunks: [],
  })

  // Row 10, connection refused: a second adapter instance pointed at a
  // freshly closed loopback port. Loaded LAST because OPENCODE_ZEN_BASE is
  // re-read at module load. No request can arrive, so only the failure
  // snapshot is observable (there is no path to assert against).
  const deadPort = await closedPort()
  const downed = loadAdapter(`http://127.0.0.1:${deadPort}`).adapter
  await expectRow(downed, 'row 10: connection refused (down socket) → TRANSPORT, no status, no replay', {
    scenarioName: 'ok', request: false, expected: { code: 'TRANSPORT', status: 'absent', retryAfterMs: 'absent' }, chunks: [],
  })

  await new Promise((resolve) => {
    server.closeAllConnections()
    server.close(resolve)
  })
  rmSync(TEST_TMP, { recursive: true, force: true })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log('failed checks:')
    for (const entry of failures) console.log(`  - ${entry.label}`)
    process.exitCode = 1
  }
}

run().catch((error) => {
  console.error('test stand crashed:', error)
  process.exitCode = 1
})
