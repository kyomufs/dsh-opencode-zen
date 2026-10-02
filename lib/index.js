'use strict'
/**
 * dsh-opencode-zen — OpenCode Zen free models + CLI disguise headers
 *
 * Combined plugin that:
 * 1. Registers OpenCode Zen free models as a DSH LLM provider
 * 2. Injects CLI-identical disguise headers (x-opencode-client, session, etc.)
 * 3. Adds gate tools (bash, read) to satisfy the free-lane agent-shape gate
 * 4. Routes Responses-only models (muse-spark-*) through POST /zen/v1/responses
 * 5. Owns stream liveness (first-event + body-idle watchdogs) and reports
 *    DSH-native failure codes so the host's retry policy can act on them
 *
 * Since 2026-09-16, Zen free tier requires canonical session format + disguise headers
 * Fix based on opencode2dsh (https://github.com/FishBottle7/opencode2dsh)
 */

const { readFileSync, existsSync, statSync } = require('node:fs')
const { appendFile } = require('node:fs/promises')
const { join } = require('node:path')
const { homedir } = require('node:os')
const { AsyncLocalStorage } = require('node:async_hooks')
const { randomUUID, createHash, randomBytes } = require('node:crypto')

const name = 'dsh-opencode-zen'
const inject = ['llm']

const PROVIDER = 'opencode'
// Test/tuning override: point the adapter at a local wire for E2E tests.
const OPENCODE_BASE = process.env.OPENCODE_ZEN_BASE || 'https://opencode.ai/zen/v1'
// DSH_HOME is always set by the harness; the homedir fallback covers direct
// invocation (tests, tooling). Hardcoding ~/.dsh reads the wrong pool file on
// any profile with a custom DSH_HOME.
const DSH_HOME = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
  ? process.env.DSH_HOME.trim()
  : join(homedir(), '.dsh')
const POOL_FILE = process.env.OPENCODE_ZEN_POOL_FILE
  || join(DSH_HOME, 'profiles', 'web', 'plugins', 'dsh-api-key-pool', 'pool-config.json')

// Model ids verified against GET opencode.ai/zen/v1/models (2026-10-02, all
// nine present) and models.dev metadata for context/output budgets.
// `reasoningRequired: true` — Zen rejects the request with HTTP 400
// ("Reasoning is mandatory for this endpoint and cannot be disabled.")
// when reasoning_effort is omitted, so effort must always be sent for these.
// `vision: true` — verified against the live Zen wire with an image request
// (64x64 solid-red PNG asked "what color?" answered "Red"). Both Nemotrons
// accept text but reject image requests with HTTP 400
// ("Upstream request failed: Endpoint is unavailable."), so they stay
// text-only. jev/ling/muse were unreachable for text AND image during
// verification (HTTP 400/500), so they stay text-only until a probe passes;
// re-run an image probe before flipping them.
// `responses: true` — the model answers only on POST /zen/v1/responses;
// /chat/completions returns a bare 500 "Internal server error"
// (opencode #44659/#44847, DSH #3957; live-reproduced 2026-10-02).
// `efforts` — the reasoning ladder the id actually answers on; ids outside
// the declaration are a hard 400 at the Zen gateway, and the mimo chat
// endpoints answer a bare 500 "Internal server error" for minimal / xhigh /
// max (live-probed 2026-10-02; max failed 3/3 attempts on both mimo ids).
const MODELS = [
  { id: 'big-pickle', name: 'Big Pickle (Free)', contextWindow: 200000, maxOutput: 32000, description: 'OpenCode Zen free', vision: true },
  { id: 'jev-1.13-free', name: 'Jev 1.13 (Free)', contextWindow: 200000, maxOutput: 32000, description: 'OpenCode Zen free (limits unpublished; conservative budget)' },
  { id: 'ling-3.0-flash-fin-free', name: 'Ling 3.0 Flash Fin (Free)', contextWindow: 262144, maxOutput: 32768, description: 'OpenCode Zen free: reasoning + tool calls, daily driver' },
  { id: 'mimo-v2.5-free', name: 'MiMo 2.5 (Free)', contextWindow: 200000, maxOutput: 32000, description: 'OpenCode Zen free', vision: true, efforts: ['off', 'low', 'medium', 'high'] },
  { id: 'mimo-v2.6-flash-free', name: 'MiMo 2.6 Flash (Free)', contextWindow: 200000, maxOutput: 32000, description: 'OpenCode Zen free', vision: true, efforts: ['off', 'low', 'medium', 'high'] },
  { id: 'muse-spark-1.3-contributor-free', name: 'Muse Spark 1.3 Contributor (Free)', contextWindow: 1048576, maxOutput: 131072, description: 'OpenCode Zen free · Responses wire (auto-routed via /responses)', responses: true, efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'] },
  { id: 'nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning (Free)', contextWindow: 262144, maxOutput: 262144, description: 'OpenCode Zen free (NVIDIA)' },
  { id: 'nemotron-3-ultra-free', name: 'Nemotron 3 Ultra (Free)', contextWindow: 1000000, maxOutput: 128000, description: 'OpenCode Zen free (NVIDIA)' },
  { id: 'space-bunny-free', name: 'Space Bunny (Free)', contextWindow: 1048576, maxOutput: 524288, description: 'OpenCode Zen free · OpenRouter-backed, reasoning always on', reasoningRequired: true, vision: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
]

const DEFAULT_EFFORT_IDS = ['off', 'low', 'high', 'max']
// Full reasoning vocabulary across all Zen wires, ordered. Used to clamp a
// requested effort to the nearest level the model actually declares — the
// mimo chat endpoints answer HTTP 500 "Internal server error" for minimal /
// xhigh / max (live-probed 2026-10-02; max failed 3/3 attempts), and a stale
// saved config can still carry 'max' after the UI stops offering it.
const EFFORT_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const EFFORT_NAMES = { off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'X-High', max: 'Max' }
const EFFORT_DESCRIPTIONS = {
  off: 'No thinking, fastest',
  minimal: 'Minimal thinking',
  low: 'Light thinking',
  medium: 'Moderate thinking',
  high: 'Deep thinking (default)',
  xhigh: 'Very deep thinking',
  max: 'Extreme thinking, most quota',
}

const DEFAULT_REASONING = 'high'
const DEFAULT_MAX_TOKENS = 32000
const DEFAULT_CONTEXT_WINDOW = 200000

// Stream-liveness windows (ms). Neither fetch's timeout (which is cleared as
// soon as response headers arrive) nor the SSE reader owns body silence, so a
// tunnel that stands but never streams hangs the turn forever — live-observed
// by opencode2dsh (70 minutes). Tunable via env for tests.
const MAX_REQUEST_ATTEMPTS = 2
const FIRST_EVENT_TIMEOUT_MS = positiveEnv('DSH_ZEN_FIRST_EVENT_MS', 30000)
const BODY_IDLE_TIMEOUT_MS = positiveEnv('DSH_ZEN_IDLE_MS', 120000)
// Responses models pace chain-of-thought in bursts with long pauses; the
// chat default misreads slow reasoning as a dead tunnel.
const RESPONSES_BODY_IDLE_TIMEOUT_MS = positiveEnv('DSH_ZEN_RESPONSES_IDLE_MS', 300000)

function positiveEnv(key, fallback) {
  const raw = Number(process.env[key])
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

// Codes the adapter retries internally before any content reached the host.
// They mirror the host retryable set (RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT/
// EMPTY_RESPONSE) so both layers agree on what is worth repeating.
const RETRYABLE_INNER = new Set(['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE'])

// Canonical retry-policy config. dsh-llm registers whatever providerRetryPolicy
// returns AS-IS (prepareRoutes never runs resolveRetryPolicy on adapter-owned
// policies), and dsh-llm-retry reads initialDelayMs/maxDelayMs/jitterRatio from
// the TOP level of that object. The nested `backoff` form below is only the
// configuration shape; returning it verbatim made localDelay compute
// undefined * 1 = NaN, which then failed the session's lossless-JSON snapshot
// (`session event "llm/retry" carries non-JSON-serializable data`) and killed
// the whole turn. resolveRetryPolicy produces the flattened runtime shape.
const RETRY_POLICY_CONFIG = {
  mode: 'normal',
  maxRetries: 3,
  retryableCodes: ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE'],
  backoff: { initialDelayMs: 800, maxDelayMs: 8000, jitterRatio: 0.2 },
}

let resolveRetryPolicyImpl = null
try {
  // Present whenever the host loads this plugin (peer dependency). Standalone
  // test runs without the peer fall back to the manual flatten below.
  resolveRetryPolicyImpl = require('@deepseek-ai/dsh-llm').resolveRetryPolicy
} catch { /* no host peer available: flattened fallback still applies */ }

function resolveProviderRetryPolicy() {
  if (resolveRetryPolicyImpl) {
    try {
      return resolveRetryPolicyImpl(RETRY_POLICY_CONFIG, 'dsh-opencode-zen: retryPolicy')
    } catch { /* config rejected by this host version: use the literal shape */ }
  }
  return Object.freeze({
    mode: RETRY_POLICY_CONFIG.mode,
    maxRetries: RETRY_POLICY_CONFIG.maxRetries,
    retryableCodes: Object.freeze([...RETRY_POLICY_CONFIG.retryableCodes]),
    initialDelayMs: RETRY_POLICY_CONFIG.backoff.initialDelayMs,
    maxDelayMs: RETRY_POLICY_CONFIG.backoff.maxDelayMs,
    jitterRatio: RETRY_POLICY_CONFIG.backoff.jitterRatio,
  })
}

// --- Canonical session ID (from opencode2dsh ids.ts) ---

const CANONICAL_SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

function base62Fixed(value, width) {
  const base = BigInt(62)
  let n = value
  const out = new Array(width)
  for (let i = width - 1; i >= 0; i--) {
    out[i] = BASE62_ALPHABET.charAt(Number(n % base))
    n /= base
  }
  return out.join('')
}

function canonicalSessionID(signal) {
  if (CANONICAL_SESSION_PATTERN.test(signal)) return signal
  const sum = createHash('sha256').update('ses\x00' + signal).digest()
  const timePart = sum.subarray(0, 6).toString('hex')
  const randomPart = base62Fixed(BigInt('0x' + sum.subarray(6, 16).toString('hex')), 14)
  return `ses_${timePart}${randomPart}`
}

function stableID(prefix, value) {
  const sum = createHash('sha256').update(prefix + '\x00' + value).digest()
  return `${prefix}_${sum.subarray(0, 12).toString('hex')}`
}

function randomID(prefix, size) {
  return `${prefix}_${randomBytes(size).toString('hex')}`
}

function conversationSeed(messages) {
  for (const message of messages) {
    if (message.role !== 'user') continue
    const encoded = JSON.stringify(message.content ?? null)
    if (encoded !== 'null' && encoded.length > 0) return encoded
  }
  return ''
}

function deriveRequestIDs(messages) {
  let signal = conversationSeed(messages)
  if (signal === '' || signal === '{}') signal = randomID('fallback', 16)
  return {
    session: canonicalSessionID(signal),
    request: randomID('req', 16),
    project: stableID('prj', 'dsh-opencode-zen:default-project'),
    parentSession: '',
  }
}

// --- CLI-identical user agent ---

function opencodeUserAgent() {
  return `opencode/1.18.31 (${process.platform} ${process.arch}; node${process.versions.node})`
}

// --- Disguise headers (from opencode2dsh ids.ts) ---

function disguiseHeaders(ids) {
  return {
    'user-agent': opencodeUserAgent(),
    'x-opencode-client': 'cli',
    'x-opencode-session': ids.session,
    'x-session-affinity': ids.session,
    'X-Session-Id': ids.session,
    'x-opencode-request': ids.request,
    'x-opencode-project': ids.project,
  }
}

// --- Gate tools (bash, read) for free-lane agent-shape gate ---

const FREE_LANE_GATE_TOOL_NAMES = ['bash', 'read']

function freeLaneGateTool(toolName) {
  return {
    type: 'function',
    function: {
      name: toolName,
      description: 'Reserved for the host runtime; do not call it.',
      parameters: { type: 'object', properties: {} },
    },
  }
}

function ensureFreeLaneShape(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return body
  if (!Array.isArray(body.messages)) return body
  const tools = Array.isArray(body.tools) ? body.tools : []
  const names = new Set(
    tools.map((tool) => {
      const fn = typeof tool === 'object' && tool !== null ? tool.function : undefined
      return typeof fn === 'object' && fn !== null ? fn.name : undefined
    }),
  )
  const missing = FREE_LANE_GATE_TOOL_NAMES.filter((n) => !names.has(n))
  if (missing.length === 0) return body
  return {
    ...body,
    tools: [...tools, ...missing.map((n) => freeLaneGateTool(n))],
    ...(tools.length === 0 ? { tool_choice: 'none' } : {}),
  }
}

// --- Session header injection (from dsh-opencode-session) ---

const SESSION_HEADER = 'x-opencode-session'
const DEFAULT_PROVIDERS = ['opencode', 'opencode-go']

function resolveSessionConfig(config = {}) {
  const providers = Array.isArray(config.providers) && config.providers.length > 0
    ? config.providers.map((v) => String(v))
    : [...DEFAULT_PROVIDERS]
  const mode = config.mode === 'uuid' ? 'uuid' : 'session-id'
  const debug = config.debug === true
  const debugFile = typeof config.debugFile === 'string' && config.debugFile.length > 0
    ? config.debugFile
    : undefined
  return { providers: new Set(providers), mode, debug, debugFile }
}

function recordDebug(ctx, file, entry) {
  appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8').catch((error) => {
    ctx.logger.warn('[dsh-opencode-zen] debugFile write failed: %s', error?.message ?? String(error))
  })
}

function headerValueFor(sessionId, mode, table) {
  const raw = String(sessionId)
  if (raw.length === 0) return undefined
  if (mode !== 'uuid') return raw
  let value = table.get(raw)
  if (value === undefined) {
    value = randomUUID()
    table.set(raw, value)
  }
  return value
}

function withStore(iterable, store, als) {
  const iterator = typeof iterable[Symbol.asyncIterator] === 'function'
    ? iterable[Symbol.asyncIterator]()
    : iterable
  return {
    [Symbol.asyncIterator]() { return this },
    async next() { return als.run(store, () => iterator.next()) },
    async return(value) {
      if (typeof iterator.return === 'function') {
        try { return await iterator.return(value) } catch { /* ignore */ }
      }
      return { done: true, value }
    },
    async throw(error) {
      if (typeof iterator.throw === 'function') {
        return als.run(store, () => iterator.throw(error))
      }
      throw error
    },
  }
}

function hasSessionHeader(input, init) {
  const source = init?.headers
    ?? (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined)
  if (source === undefined) return false
  try { return new Headers(source).has(SESSION_HEADER) } catch { return false }
}

function patchFetch(original, als) {
  return function patchedFetch(input, init) {
    const state = als.getStore()
    if (state && !hasSessionHeader(input, init)) {
      const headers = new Headers(
        init?.headers
          ?? (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined),
      )
      headers.set(SESSION_HEADER, state.value)
      return original.call(this, input, { ...init, headers })
    }
    return original.apply(this, arguments)
  }
}

// --- OpenCode Zen adapter ---

function log(ctx, level, msg) {
  try { ctx.logger[level](`[dsh-opencode-zen] ${msg}`) } catch { /* noop */ }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

let _poolKeys = null
let _poolIdx = 0
let _poolMtime = null

function readPoolKeys() {
  const sources = []
  try {
    if (existsSync(POOL_FILE)) {
      const raw = JSON.parse(readFileSync(POOL_FILE, 'utf8'))
      const oc = raw?.pools?.opencode || raw?.pools?.['opencode-zen']
      if (oc && Array.isArray(oc.keys)) sources.push(...oc.keys.filter((k) => k && k !== 'public'))
    }
  } catch { /* ignore */ }
  const env = process.env.OPENCODE_ZEN_API_KEY || process.env.OPENCODE_GO_API_KEY
  if (env) sources.push(env)
  const dedup = [...new Set(sources)]
  return dedup.length > 0 ? dedup : ['public']
}

/**
 * Round-robin key pool with mtime-based reload: dsh-api-key-pool rewrites its
 * config at runtime, and a plugin that caches the key list until restart keeps
 * burning keys the user already removed (or ignores the ones they just added).
 */
function loadPoolKeys() {
  let mtime = null
  try { if (existsSync(POOL_FILE)) mtime = statSync(POOL_FILE).mtimeMs } catch { mtime = null }
  if (_poolKeys === null || mtime !== _poolMtime) {
    _poolMtime = mtime
    _poolKeys = readPoolKeys()
    _poolIdx = _poolIdx % _poolKeys.length
  }
  return _poolKeys
}

function resolveApiKey() {
  const keys = loadPoolKeys()
  const key = keys[_poolIdx % keys.length]
  _poolIdx = (_poolIdx + 1) % keys.length
  return key
}

// --- Durable image blocks (vision-capable routes) ---

function isImageBlock(block) {
  return block !== null && typeof block === 'object' && block.type === 'image' && block.attachment !== undefined
}

/**
 * One durable image block -> one OpenAI wire part. The attachment service is
 * the only owner of the bytes; without it the occurrence degrades to stable
 * text instead of silently disappearing from the request.
 */
async function imagePart(block, store) {
  const ref = block.attachment
  if (store === undefined || store === null || typeof store.readImage !== 'function') {
    return { type: 'text', text: '[image omitted: attachment service is not mounted]' }
  }
  try {
    const stored = await store.readImage(ref)
    const bytes = stored?.data
    if (!(bytes instanceof Uint8Array) && !Buffer.isBuffer(bytes)) throw new Error('attachment store returned no bytes')
    const mediaType = stored?.ref?.mediaType || ref.mediaType || 'image/png'
    return { type: 'image_url', image_url: { url: `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}` } }
  } catch (error) {
    return { type: 'text', text: `[image omitted: ${error?.message ?? String(error)}]` }
  }
}

async function imagePartsOf(content, store) {
  const blocks = Array.isArray(content) ? content : []
  const parts = []
  for (const block of blocks) if (isImageBlock(block)) parts.push(await imagePart(block, store))
  return parts
}

/**
 * Serialize DSH messages into OpenAI wire messages.
 *
 * Images from tool results are buffered and folded into the next user slot
 * (or flushed as their own): OpenAI tool messages carry text only, so their
 * images must travel in an adjacent user message without splitting the run of
 * tool messages that answers one assistant tool call.
 */
async function serializeMessages(messages, systemPrompt, store) {
  const wire = []
  if (systemPrompt) wire.push({ role: 'system', content: systemPrompt })
  let pendingImages = []

  const userContent = async (m) => {
    const parts = []
    if (typeof m.content === 'string' && m.content.length > 0) parts.push({ type: 'text', text: m.content })
    else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block.type === 'text') { if (block.text) parts.push({ type: 'text', text: block.text }) }
        else if (isImageBlock(block)) parts.push(await imagePart(block, store))
      }
    }
    if (pendingImages.length > 0) { parts.push(...pendingImages); pendingImages = [] }
    if (parts.length === 0) return ''
    if (parts.length === 1 && parts[0].type === 'text') return parts[0].text
    return parts
  }

  const flushPendingImages = () => {
    if (pendingImages.length === 0) return
    wire.push({ role: 'user', content: pendingImages })
    pendingImages = []
  }

  for (const m of messages || []) {
    const role = m.role
    if (role === 'system') {
      flushPendingImages()
      wire.push({ role: 'system', content: flattenText(m.content) })
      continue
    }
    if (role === 'assistant') {
      flushPendingImages()
      const text = flattenText(m.content)
      const reasoning = blocksOf(m.content, 'reasoning').map((b) => b.text).join('')
      const toolCalls = blocksOf(m.content, 'tool-call').map((b) => ({
        id: b.id, type: 'function', function: { name: b.name, arguments: b.arguments },
      }))
      // An empty assistant turn is not a legal wire message; replaying it
      // would earn a hard 400 from a gateway that checks content.
      if (text.length === 0 && reasoning.length === 0 && toolCalls.length === 0) continue
      const msg = { role: 'assistant', content: text }
      if (reasoning) msg.reasoning_content = reasoning
      if (toolCalls.length) msg.tool_calls = toolCalls
      wire.push(msg)
      continue
    }
    const toolResults = blocksOf(m.content, 'tool-result')
    const text = flattenText(m.content)
    if (text || toolResults.length === 0) {
      const content = await userContent(m)
      // Skip user turns that serialize to nothing (empty text and no images);
      // tool results below still travel as their own messages.
      if (content !== '') wire.push({ role: 'user', content })
    }
    for (const r of toolResults) {
      wire.push({ role: 'tool', tool_call_id: r.toolCallId, content: flattenText(r.content) || '(no output)' })
      pendingImages.push(...await imagePartsOf(r.content, store))
    }
  }
  flushPendingImages()
  return wire
}

function flattenText(content) {
  if (Array.isArray(content)) {
    return content.filter((b) => b.type === 'text').map((b) => b.text).join('')
  }
  return typeof content === 'string' ? content : ''
}

function blocksOf(content, type) {
  return Array.isArray(content) ? content.filter((b) => b.type === type) : []
}

function serializeTools(tools) {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      // A tool without a schema serializes to a body the gateway can reject;
      // every function tool must declare an object parameters schema.
      parameters: t.parameters && typeof t.parameters === 'object' ? t.parameters : { type: 'object', properties: {} },
    },
  }))
}

// --- Failure taxonomy -------------------------------------------------------
//
// DSH only honors an adapter failure when the error carries BOTH an own
// `code` data property and a matching `failure = { message, code, status? }`
// snapshot (dsh-llm normalizeLlmFailure). A bare `error.code` degrades to
// "UNKNOWN", which is in no retryable set — the turn dies on the first
// glitch. Every error this module throws therefore goes through typedError.

function typedError(failure) {
  const error = new Error(failure.message)
  error.code = failure.code
  error.failure = { ...failure }
  return error
}

function isTyped(value) {
  return value !== null && typeof value === 'object'
    && typeof value.code === 'string'
    && typeof value.failure === 'object' && value.failure !== null
    && value.failure.code === value.code
    && typeof value.failure.message === 'string' && value.failure.message.length > 0
}

function errorText(err) {
  const parts = []
  const seen = new Set()
  let current = err
  while (current !== null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const message = typeof current.message === 'string' && current.message.length > 0
      ? current.message
      : String(current.name || 'error')
    parts.push(message)
    current = current.cause
  }
  if (parts.length === 0) return String(err)
  return parts.join(': ')
}

function httpFailure(status, raw, retryAfterMs) {
  const snippet = String(raw || '').slice(0, 300)
  // A 403 whose body reports the PROVIDER's outage is a transient server
  // condition wearing the wrong status — live-observed 2026-10-02 as
  // "Error from provider (Console): Upstream request failed: Endpoint is
  // unavailable." Classifying it as a terminal quota gate left ling / nemotron
  // / muse turns dead on the first attempt; SERVER lets both retry layers
  // ride out a short upstream blip instead.
  const upstreamOutage = status === 403 && /endpoint is unavailable|upstream request failed/i.test(snippet)
  let code = 'PROVIDER_ERROR'
  if (status === 429) code = 'RATE_LIMIT'
  else if (status === 408) code = 'TIMEOUT'
  else if (status === 401) code = 'INVALID_CREDENTIAL'
  else if (status >= 500) code = 'SERVER'
  else if (status === 400 && /context[\s_-]?(?:length|window)/i.test(snippet) && /(?:exceed|too\s+(?:large|long)|overflow)/i.test(snippet)) {
    code = 'CONTEXT_WINDOW_EXCEEDED'
  } else if (upstreamOutage) code = 'SERVER'
  let message = `OpenCode Zen HTTP ${status}${snippet ? `: ${snippet}` : ''}`
  if (status === 403) {
    if (upstreamOutage) {
      message += ' — upstream provider outage ("Endpoint is unavailable"); transient, retried under the SERVER policy.'
    } else {
      message += /freetiererror/i.test(snippet)
        ? ' — free-lane gate: a canonical ses_ session plus the CLI disguise headers are required, or the anonymous per-IP quota is cooling down.'
        : ' — anonymous-lane refusal (per-IP quota, region gate, or model gate); wait for the quota window or switch model.'
    }
  }
  return typedError({ message, code, status, ...(retryAfterMs ? { providerRetryAfterMs: retryAfterMs } : {}) })
}

function parseRetryAfter(header) {
  if (typeof header !== 'string' || header.length === 0) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1000, seconds * 1000)
  const when = Date.parse(header)
  if (!Number.isNaN(when)) return Math.max(1000, when - Date.now())
  return undefined
}

/**
 * Normalize a raw throw (undici `terminated`, AbortError, plain TypeError)
 * into the adapter's failure taxonomy. `timedOut` marks our own watchdog,
 * `callerAborted` marks a host-side cancellation (surfaces as ABORTED, which
 * DSH reports as an aborted finish rather than an error).
 */
function ensureTyped(err, context = {}) {
  if (isTyped(err)) return err
  const text = errorText(err)
  const errName = err !== null && typeof err === 'object' ? err.name : ''
  if (context.callerAborted || errName === 'AbortError' && context.callerAborted) {
    return typedError({ message: 'OpenCode Zen request aborted by caller', code: 'ABORTED' })
  }
  if (context.timedOut || errName === 'AbortError') {
    return typedError({ message: `OpenCode Zen stream timed out: ${text || 'no data from upstream'}`, code: 'TIMEOUT' })
  }
  const message = /terminat|premature|econn|socket|fetch failed|other side closed|req closed|network/i.test(text)
    ? `OpenCode Zen transport error: ${text}`
    : `OpenCode Zen stream failed: ${text || 'unknown failure'}`
  return typedError({ message, code: 'TRANSPORT' })
}

function aborted() {
  return typedError({ message: 'OpenCode Zen request aborted by caller', code: 'ABORTED' })
}

function retryDelay(attempt, failure) {
  const jitter = Math.floor(Math.random() * 250)
  if (failure?.code === 'RATE_LIMIT') {
    // Honor Retry-After instead of hammering a window that asked for time;
    // capped so a hostile header cannot park the turn for minutes.
    const asked = failure.providerRetryAfterMs || 0
    return Math.min(Math.max(asked, 800) + jitter, 15000)
  }
  return Math.min(400 * (attempt + 1) + jitter, 5000)
}

// --- Stream watchdog --------------------------------------------------------
//
// One AbortController owns connect + headers + body for the whole attempt.
// The watchdog is re-armed around every reader.read(): FIRST_EVENT until the
// first parsed SSE data line, BODY_IDLE after that. A fired watchdog aborts
// the controller, the pending read rejects, and ensureTyped maps it to a
// typed TIMEOUT instead of a silent hang.

function createWatchdog(controller, state, idleMs, firstMs = FIRST_EVENT_TIMEOUT_MS) {
  let timer = null
  const fire = () => {
    state.timedOut = true
    try { controller.abort() } catch { /* noop */ }
  }
  const arm = (ms) => {
    clearTimeout(timer)
    timer = setTimeout(fire, ms)
    if (typeof timer.unref === 'function') timer.unref()
  }
  return {
    armFirst: () => arm(firstMs),
    armIdle: () => arm(idleMs),
    disarm: () => { clearTimeout(timer); timer = null },
  }
}

async function* parseSse(response, watchdog, probe = { sawDone: false, sawFinish: false }) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let sawData = false
  try {
    while (true) {
      if (sawData) watchdog.armIdle()
      else watchdog.armFirst()
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data) continue
        if (data === '[DONE]') { probe.sawDone = true; return }
        try {
          sawData = true
          yield JSON.parse(data)
        } catch { /* ignore bad line */ }
      }
    }
  } finally {
    // Cancel instead of merely unlocking: an abandoned reader leaks the
    // socket, and leaked sockets accumulate into turn-level stalls.
    try { await reader.cancel() } catch { /* noop */ }
    try { reader.releaseLock() } catch { /* noop */ }
  }
}

async function* translateStream(rawChunks, estimateInput, probe = { sawDone: false, sawFinish: false }) {
  let nextIndex = 0
  let textBlock = null
  let reasoningBlock = null
  const toolBlocks = new Map()
  const order = []
  let finish = null
  let usage = null

  const open = (kind) => {
    const block = { index: nextIndex++, kind, text: '' }
    order.push(block)
    return block
  }

  for await (const chunk of rawChunks) {
    const choices = chunk.choices || []
    for (const choice of choices) {
      const delta = choice.delta || {}
      const rc = delta.reasoning_content
      if (typeof rc === 'string' && rc.length > 0) {
        if (!reasoningBlock) {
          reasoningBlock = open('reasoning')
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
        }
        reasoningBlock.text += rc
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: rc }
      }
      const content = delta.content
      if (typeof content === 'string' && content.length > 0) {
        if (!textBlock) {
          textBlock = open('text')
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
        }
        textBlock.text += content
        yield { type: 'text-delta', index: textBlock.index, text: content }
      }
      for (const call of delta.tool_calls || []) {
        const idx = call.index || 0
        let block = toolBlocks.get(idx)
        if (!block) {
          block = open('tool-call')
          toolBlocks.set(idx, block)
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        }
        const fn = call.function || {}
        if (call.id) block.callId = call.id
        if (fn.name) block.name = fn.name
        if (fn.arguments) {
          block.text += fn.arguments
          yield { type: 'tool-call-delta', index: block.index, id: block.callId || '', name: block.name || '', argumentsDelta: fn.arguments }
        }
      }
      if (choice.finish_reason) probe.sawFinish = true
      // finish_reason lives on the choice, not on the chunk — reading
      // chunk.finish_reason here meant max-tokens was never detected.
      if (choice.finish_reason === 'length') finish = { kind: 'max-tokens' }
    }
    if (chunk.usage) { usage = mapUsage(chunk.usage); probe.sawFinish = true }
  }

  // A degenerate completion with zero blocks would silently end the turn with
  // nothing to show or act on; classify it so the retry policy may repeat it.
  if (order.length === 0) {
    throw typedError({ message: 'OpenCode Zen returned an empty response', code: 'EMPTY_RESPONSE' })
  }

  for (const block of order) {
    switch (block.kind) {
      case 'text': yield { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } }; break
      case 'reasoning': yield { type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } }; break
      case 'tool-call':
        yield {
          type: 'block-end',
          index: block.index,
          block: { type: 'tool-call', id: block.callId || '', name: block.name || '', arguments: block.text },
        }
        break
    }
  }

  if (!usage && estimateInput) {
    const inputText = estimateInput()
    usage = {
      inputTokens: Math.ceil(inputText.length / 4),
      outputTokens: (textBlock?.text || '').length > 0 ? Math.ceil(textBlock.text.length / 4) : 0,
    }
  }
  yield { type: 'usage', usage }
  yield { type: 'finish', reason: finish || { kind: 'stop' } }
}

function mapUsage(usage) {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens || 0
  return {
    inputTokens: (usage.prompt_tokens || 0) - (cacheRead || 0),
    outputTokens: usage.completion_tokens || 0,
    ...(cacheRead ? { cacheReadTokens: cacheRead } : {}),
  }
}

function mapResponsesUsage(usage) {
  const cacheRead = usage.input_tokens_details?.cached_tokens || 0
  return {
    inputTokens: (usage.input_tokens || 0) - cacheRead,
    outputTokens: usage.output_tokens || 0,
    ...(cacheRead ? { cacheReadTokens: cacheRead } : {}),
  }
}

// --- Responses wire (muse-spark-* and any future Responses-only model) ------

function isResponsesModel(model) {
  return findModel(model)?.responses === true
}

function serializeResponsesTools(tools) {
  if (!tools || tools.length === 0) return []
  return tools.map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.parameters && typeof t.parameters === 'object' ? t.parameters : { type: 'object', properties: {} },
  }))
}

function ensureResponsesGateTools(tools) {
  const names = new Set(tools.map((t) => t.name))
  const next = [...tools]
  for (const toolName of FREE_LANE_GATE_TOOL_NAMES) {
    if (!names.has(toolName)) next.push({ type: 'function', ...freeLaneGateTool(toolName).function })
  }
  return next
}

/**
 * Rewrite the already-serialized OpenAI chat wire into a Responses request.
 * Assistant reasoning history is intentionally not replayed: the gateway
 * wants `encrypted_content` for reasoning round-trips, which the chat wire
 * never carried — plain text plus the tool calls keeps history faithful
 * enough without risking a hard 400.
 */
function buildResponsesBody({ model, wireMessages, tools, maxTokens, effort, temperature }) {
  let instructions
  const input = []
  for (const m of wireMessages) {
    if (m.role === 'system') {
      instructions = instructions === undefined ? m.content : `${instructions}\n\n${m.content}`
      continue
    }
    if (m.role === 'assistant') {
      const items = []
      if (m.content) items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: m.content }] })
      for (const tc of m.tool_calls || []) {
        items.push({ type: 'function_call', call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments })
      }
      if (items.length > 0) input.push(...items)
      continue
    }
    if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.tool_call_id, output: m.content || '(no output)' })
      continue
    }
    const parts = []
    if (typeof m.content === 'string') {
      if (m.content.length > 0) parts.push({ type: 'input_text', text: m.content })
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === 'image_url') parts.push({ type: 'input_image', image_url: part.image_url?.url ?? '' })
        else if (part.type === 'text' && part.text) parts.push({ type: 'input_text', text: part.text })
      }
    }
    if (parts.length > 0) input.push({ role: 'user', content: parts })
  }
  return {
    model,
    stream: true,
    input,
    // The anonymous lane 403s any body without the bash+read agent shape;
    // the Responses gateway accepts tool_choice "auto" only.
    tools: ensureResponsesGateTools(serializeResponsesTools(tools)),
    tool_choice: 'auto',
    ...(instructions ? { instructions } : {}),
    ...(maxTokens ? { max_output_tokens: maxTokens } : {}),
    ...(effort && effort !== 'none' ? { reasoning: { effort } } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
  }
}

/**
 * Translate the Responses SSE vocabulary (event: response.*) into the same
 * harness chunks the chat translator emits. Observed live 2026-10-02:
 * response.created/in_progress, output_item.added/done (reasoning | message |
 * function_call), content_part.*, output_text.delta, function_call_arguments
 * .delta, completed (carries usage), ping.
 */
async function* translateResponsesStream(rawChunks, estimateInput, probe = { sawDone: false, sawFinish: false }) {
  let nextIndex = 0
  let textBlock = null
  let reasoningBlock = null
  const toolBlocks = new Map()
  const order = []
  let finish = null
  let usage = null

  const open = (kind, seed) => {
    const block = { index: nextIndex++, kind, text: '', callId: '', name: '', ...seed }
    order.push(block)
    return block
  }

  for await (const chunk of rawChunks) {
    const type = chunk && chunk.type
    if (type === 'response.output_item.added') {
      const item = chunk.item || {}
      if (item.type === 'reasoning' && reasoningBlock === null) {
        reasoningBlock = open('reasoning')
        yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
      } else if (item.type === 'message' && textBlock === null) {
        textBlock = open('text')
        yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
      } else if (item.type === 'function_call') {
        const block = open('tool-call', { callId: item.call_id || '', name: item.name || '' })
        toolBlocks.set(chunk.output_index, block)
        yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
      }
      continue
    }
    if (type === 'response.reasoning_text.delta' || type === 'response.reasoning_summary_text.delta') {
      const delta = typeof chunk.delta === 'string' ? chunk.delta : ''
      if (delta.length === 0) continue
      if (reasoningBlock === null) {
        reasoningBlock = open('reasoning')
        yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
      }
      reasoningBlock.text += delta
      yield { type: 'reasoning-delta', index: reasoningBlock.index, text: delta }
      continue
    }
    if (type === 'response.output_text.delta') {
      const delta = typeof chunk.delta === 'string' ? chunk.delta : ''
      if (delta.length === 0) continue
      if (textBlock === null) {
        textBlock = open('text')
        yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
      }
      textBlock.text += delta
      yield { type: 'text-delta', index: textBlock.index, text: delta }
      continue
    }
    if (type === 'response.function_call_arguments.delta') {
      const delta = typeof chunk.delta === 'string' ? chunk.delta : ''
      let block = toolBlocks.get(chunk.output_index)
      if (!block) {
        block = open('tool-call')
        toolBlocks.set(chunk.output_index, block)
        yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
      }
      if (delta.length > 0) {
        block.text += delta
        yield { type: 'tool-call-delta', index: block.index, id: block.callId, name: block.name, argumentsDelta: delta }
      }
      continue
    }
    if (type === 'response.output_item.done') {
      const item = chunk.item || {}
      if (item.type === 'function_call') {
        const block = toolBlocks.get(chunk.output_index)
        if (block) {
          if (item.call_id) block.callId = item.call_id
          if (item.name) block.name = item.name
          if (typeof item.arguments === 'string' && block.text.length === 0) block.text = item.arguments
        }
      }
      continue
    }
    if (type === 'response.completed') {
      probe.sawFinish = true
      const response = chunk.response || {}
      if (response.usage) usage = mapResponsesUsage(response.usage)
      if (response.status === 'incomplete' && response.incomplete_details?.reason === 'max_output_tokens') {
        finish = { kind: 'max-tokens' }
      }
      continue
    }
    if (type === 'response.failed' || type === 'response.error' || type === 'error') {
      probe.sawFinish = true
      const detail = chunk.error?.message || chunk.response?.error?.message || 'Responses stream reported an error'
      throw typedError({ message: `OpenCode Zen responses error: ${detail}`, code: 'SERVER' })
    }
  }

  if (order.length === 0) {
    throw typedError({ message: 'OpenCode Zen returned an empty response', code: 'EMPTY_RESPONSE' })
  }

  for (const block of order) {
    switch (block.kind) {
      case 'text': yield { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } }; break
      case 'reasoning': yield { type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } }; break
      case 'tool-call':
        yield {
          type: 'block-end',
          index: block.index,
          block: { type: 'tool-call', id: block.callId || '', name: block.name || '', arguments: block.text },
        }
        break
    }
  }

  if (!usage && estimateInput) {
    const inputText = estimateInput()
    usage = {
      inputTokens: Math.ceil(inputText.length / 4),
      outputTokens: (textBlock?.text || '').length > 0 ? Math.ceil(textBlock.text.length / 4) : 0,
    }
  }
  yield { type: 'usage', usage }
  yield { type: 'finish', reason: finish || { kind: 'stop' } }
}

// --- Model helpers ----------------------------------------------------------

function findModel(model) {
  return MODELS.find((m) => m.id === model)
}

function effortLevels(meta) {
  const ids = Array.isArray(meta?.efforts) && meta.efforts.length > 0 ? meta.efforts : DEFAULT_EFFORT_IDS
  return ids.map((id) => ({
    id,
    name: EFFORT_NAMES[id] || id,
    description: EFFORT_DESCRIPTIONS[id] || 'Reasoning effort level',
  }))
}

/** Per-model output budget: never ask for more tokens than the model serves. */
function resolveMaxTokens(meta, requested) {
  const cap = meta?.maxOutput ?? DEFAULT_MAX_TOKENS
  if (Number.isSafeInteger(requested) && requested > 0) return Math.min(requested, cap)
  return cap
}

/**
 * Resolve the reasoning_effort actually sent to Zen.
 *
 * Wire vocabulary at the gateway: minimal | low | medium | high | xhigh | max
 * | none, but each id answers only a subset — the mimo chat endpoints reply
 * HTTP 500 "Internal server error" to minimal / xhigh / max (live-probed
 * 2026-10-02). `off` maps to `none` — merely omitting the field keeps the
 * provider default (thinking on), which wastes the free quota on models that
 * can actually be silenced. Responses models expose no `none`, so `off`
 * omits the field there. A selected effort outside the model's declared
 * ladder (e.g. 'max' left over in a saved config) is clamped to the nearest
 * declared level instead of being forwarded to a 500. Most models accept an
 * omitted effort; space-bunny-free answers HTTP 400
 * "Reasoning is mandatory for this endpoint and cannot be disabled.",
 * so it falls back to the default effort instead.
 */
function resolveReasoningEffort(model, reasoningEffort) {
  const meta = findModel(model)
  const requested = reasoningEffort && reasoningEffort !== 'off' ? reasoningEffort : undefined
  if (reasoningEffort === 'off') return meta?.responses === true ? undefined : 'none'
  if (requested !== undefined) return clampEffort(meta, requested)
  if (meta?.reasoningRequired === true) return DEFAULT_REASONING
  return undefined
}

/** Nearest declared level for a requested effort; ties resolve upward. */
function clampEffort(meta, requested) {
  const declared = effortLevels(meta).map((level) => level.id)
  if (declared.includes(requested)) return requested
  const requestedIdx = EFFORT_ORDER.indexOf(requested)
  const declaredIdx = declared.map((id) => EFFORT_ORDER.indexOf(id)).filter((idx) => idx >= 0)
  if (requestedIdx === -1 || declaredIdx.length === 0) {
    return declared.includes(DEFAULT_REASONING) ? DEFAULT_REASONING : declared[0]
  }
  let best = declaredIdx[0]
  for (const idx of declaredIdx.slice(1)) {
    if (Math.abs(idx - requestedIdx) <= Math.abs(best - requestedIdx)) best = idx
  }
  return EFFORT_ORDER[best]
}

class OpenCodeZenAdapter {
  constructor(ctx) { this.ctx = ctx }
  providerInfo(provider) { return { id: provider, name: 'OpenCode Zen' } }
  providerRetryPolicy() {
    // Codes must match dsh-llm's taxonomy (RATE_LIMIT, SERVER, TIMEOUT,
    // TRANSPORT, EMPTY_RESPONSE) — the previous list said "RATE_LIMITED",
    // which is in no retryable set, so the host never recovered a single
    // failed attempt. The returned value must be the RESOLVED (flattened)
    // policy: see RETRY_POLICY_CONFIG for the NaN-delay incident.
    return resolveProviderRetryPolicy()
  }
  // dsh >= 0.1.2 token meter calls this with no feature check. Adapters that
  // do not extend the LlmAdapter base class must supply it themselves; this
  // route declares no provider-side image pricing, so the meter keeps its
  // neutral estimate (same approach as @liustack/modlens).
  imageRequestPricing() {
    return undefined
  }
  listModels() {
    // DSH gates read_image and image passthrough on the declared modalities,
    // so only models verified against the Zen wire (see `vision` in MODELS)
    // advertise 'image'.
    return Promise.resolve(MODELS.map((m) => ({ provider: PROVIDER, id: m.id, name: m.name, description: m.description, inputModalities: m.vision === true ? ['text', 'image'] : ['text'] })))
  }
  resolveModel(provider, model) {
    const found = findModel(model)
    return Promise.resolve({
      provider,
      id: model,
      name: found?.name || model,
      ...(found?.description ? { description: found.description } : {}),
      inputModalities: found?.vision === true ? ['text', 'image'] : ['text'],
      context: { contextWindow: found?.contextWindow || DEFAULT_CONTEXT_WINDOW },
      defaultMaxTokens: found?.maxOutput || DEFAULT_MAX_TOKENS,
      reasoning: {
        efforts: effortLevels(found),
        defaultEffort: DEFAULT_REASONING,
      },
    })
  }

  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    }
  }

  async *stream(options) {
    const { model, messages, system, tools, maxTokens, temperature, signal } = options
    const selectedEffort = options.reasoningEffort ?? options.reasoning
    const meta = findModel(model)
    const effort = resolveReasoningEffort(model, selectedEffort)
    const store = this.ctx?.get?.('attachments')
    const wireMessages = await serializeMessages(messages, system, store)
    const wireTools = serializeTools(tools)

    // Derive canonical session/request IDs for this conversation. The
    // session stays sticky across attempts; the request id is refreshed per
    // attempt so a retry never reuses a spent request id.
    const ids = deriveRequestIDs(messages)
    const useResponses = isResponsesModel(model)
    const limit = resolveMaxTokens(meta, maxTokens)

    const body = useResponses
      ? buildResponsesBody({ model, wireMessages, tools, maxTokens: limit, effort, temperature })
      : ensureFreeLaneShape({
        model,
        messages: wireMessages,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: limit,
        top_p: 0.95,
        ...(temperature !== undefined ? { temperature } : {}),
        ...(wireTools ? { tools: wireTools, tool_choice: 'auto' } : {}),
        ...(effort ? { reasoning_effort: effort } : {}),
      })

    const url = useResponses ? `${OPENCODE_BASE}/responses` : `${OPENCODE_BASE}/chat/completions`
    const idleMs = useResponses ? RESPONSES_BODY_IDLE_TIMEOUT_MS : BODY_IDLE_TIMEOUT_MS
    const estimateInput = () => JSON.stringify(wireMessages)

    let yieldedContent = false
    let openedToolCall = false
    let lastError = null
    // The body never changes across attempts — serialize it once instead of
    // rebuilding the JSON on every retry.
    const bodyText = JSON.stringify(body)

    for (let attempt = 0; attempt < MAX_REQUEST_ATTEMPTS; attempt++) {
      if (signal?.aborted) throw aborted()
      const attemptIds = { ...ids, request: randomID('req', 16) }
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resolveApiKey()}`,
        ...disguiseHeaders(attemptIds),
      }
      const controller = new AbortController()
      const state = { timedOut: false }
      const watchdog = createWatchdog(controller, state, idleMs)
      const onAbort = () => controller.abort()
      if (signal) signal.addEventListener('abort', onAbort, { once: true })

      try {
        watchdog.armFirst()
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        })

        if (!response.ok) {
          watchdog.armFirst()
          const raw = await response.text().catch(() => '')
          const failure = httpFailure(response.status, raw, parseRetryAfter(response.headers.get('retry-after')))
          lastError = failure
          // 401 is normally terminal (INVALID_CREDENTIAL is non-retryable for
          // the host), but with a multi-key pool the next attempt draws a
          // different key via resolveApiKey(), so one in-process rotation is
          // worth it before surfacing the error.
          const rotateKey = failure.code === 'INVALID_CREDENTIAL' && failure.failure?.status === 401 && loadPoolKeys().length > 1
          const retryable = RETRYABLE_INNER.has(failure.code) || rotateKey
          if (!retryable || attempt >= MAX_REQUEST_ATTEMPTS - 1 || signal?.aborted) throw failure
          await sleep(retryDelay(attempt, failure))
          continue
        }

        const probe = { sawDone: false, sawFinish: false }
        const source = parseSse(response, watchdog, probe)
        const chunks = useResponses
          ? translateResponsesStream(source, estimateInput, probe)
          : translateStream(source, estimateInput, probe)

        for await (const chunk of chunks) {
          if (chunk && (chunk.type === 'tool-call-delta' || (chunk.type === 'block-start' && chunk.blockType === 'tool-call'))) openedToolCall = true
          if (chunk && chunk.type !== 'usage' && chunk.type !== 'finish') yieldedContent = true
          yield chunk
        }

        // The connection closed cleanly but never delivered a terminal event.
        // Text/reasoning truncation is salvageable: the translator has
        // already flushed the open blocks and synthesized finish {kind:'stop'}
        // (dsh-llm's own assemblers default a stream that ended without a
        // finish to stop), so the partial answer commits and the turn
        // continues — a replay would duplicate the output, and failing here
        // kills a turn over a gateway that merely stopped mid-sentence.
        // Before content it is a transport blip worth one retry; a tool call
        // left open cannot be verified complete, so those still fail honestly
        // rather than dispatch half-written arguments.
        const salvageable = yieldedContent && !openedToolCall
        if (!probe.sawDone && !probe.sawFinish && !salvageable) {
          const failure = typedError({
            message: yieldedContent
              ? 'OpenCode Zen stream ended without a terminal event after partial output'
              : 'OpenCode Zen stream ended before any response',
            code: yieldedContent ? 'STREAM_TRUNCATED' : 'TRANSPORT',
          })
          lastError = failure
          if (yieldedContent || attempt >= MAX_REQUEST_ATTEMPTS - 1 || signal?.aborted) throw failure
          await sleep(retryDelay(attempt, failure))
          continue
        }
        watchdog.disarm()
        return
      } catch (err) {
        const failure = ensureTyped(err, { timedOut: state.timedOut, callerAborted: signal?.aborted === true })
        lastError = failure
        // Never replay a stream that already delivered content: the second
        // attempt would repeat every block (opencode2dsh IP-7 rule).
        const retryable = !yieldedContent && !signal?.aborted && RETRYABLE_INNER.has(failure.code)
        if (!retryable || attempt >= MAX_REQUEST_ATTEMPTS - 1) throw failure
        await sleep(retryDelay(attempt, failure))
      } finally {
        watchdog.disarm()
        if (signal) signal.removeEventListener('abort', onAbort)
      }
    }
    throw lastError || typedError({ message: 'OpenCode Zen request failed', code: 'TRANSPORT' })
  }
}

// --- Main apply: registers adapter + patches fetch for session header ---

function apply(ctx, config) {
  // 1. Register the OpenCode Zen LLM adapter
  ctx.llm.registerAdapter([PROVIDER], new OpenCodeZenAdapter(ctx))
  const keys = loadPoolKeys()
  log(ctx, 'info', `provider "${PROVIDER}" registered, ${MODELS.length} free models, ${keys.length} key(s) in rotation`)

  // 2. Patch globalThis.fetch to inject x-opencode-session header
  const { providers, mode, debug, debugFile } = resolveSessionConfig(config)
  const als = new AsyncLocalStorage()
  const uuidBySession = new Map()

  const originalFetch = globalThis.fetch
  if (typeof originalFetch !== 'function') {
    log(ctx, 'warn', 'globalThis.fetch unavailable; cannot inject x-opencode-session')
    return
  }

  const patched = patchFetch(originalFetch, als)

  ctx.effect(() => {
    globalThis.fetch = patched
    log(ctx, 'info', `session header active for providers [${[...providers].join(', ')}] mode=${mode}`)
    return () => {
      if (globalThis.fetch === patched) globalThis.fetch = originalFetch
    }
  }, 'dsh-opencode-zen.fetch-patch')

  ctx.on('llm/stream', (options, next) => {
    if (options === undefined || options === null || typeof options !== 'object') return next()
    if (!providers.has(String(options.provider))) return next()
    const sessionId = options.sessionId
    if (sessionId === undefined || sessionId === null) return next()
    const value = headerValueFor(sessionId, mode, uuidBySession)
    if (value === undefined) return next()

    let downstream
    try { downstream = next() } catch (error) { throw error }
    if (downstream === undefined || downstream === null) return downstream
    if (typeof downstream[Symbol.asyncIterator] !== 'function') return downstream

    if (debug || debugFile !== undefined) {
      const entry = {
        ts: new Date().toISOString(),
        provider: options.provider,
        model: options.model,
        session: String(sessionId),
        header: SESSION_HEADER,
        value,
      }
      if (debugFile !== undefined) recordDebug(ctx, debugFile, entry)
      if (debug) {
        log(ctx, 'info', `streaming provider "${options.provider}" ${SESSION_HEADER}=${value}`)
      }
    }
    return withStore(downstream, { value }, als)
  }, { prepend: true })
}

module.exports = {
  apply,
  inject,
  name,
  OpenCodeZenAdapter,
  PROVIDER,
  MODELS,
  resolveApiKey,
  resolveReasoningEffort,
  resolveMaxTokens,
  serializeMessages,
  ensureFreeLaneShape,
  buildResponsesBody,
  parseSse,
  translateStream,
  translateResponsesStream,
  httpFailure,
  ensureTyped,
  createWatchdog,
  isResponsesModel,
}
