'use strict'

// dsh-opencode-zen — thin adapter for the local zen-router daemon.
// Plan: zen-router docs/superpowers/plans/2026-10-07-dsh-opencode-zen-thin.md
// Tasks: T2 shell + MODELS; T3 stream() transport; T4 SSE translation;
// T5 error mapping; T6 apply() health ping + daemon autostart. Loopback only;
// OPENCODE_ZEN_API_KEY is accepted but never required (no inbound auth check).

const name = 'dsh-opencode-zen'
const inject = ['llm']

const PROVIDER = 'opencode'

// Transport base — NO path: the adapter appends /v1/chat/completions and
// /v1/models itself. Tests point this at loopback fixtures via the env var.
const OPENCODE_ZEN_BASE = process.env.OPENCODE_ZEN_BASE || 'http://127.0.0.1:8787'

// --- Static model table ------------------------------------------------------
// VERBATIM copy of the 9-entry table from `git show a416790:lib/index.js`
// (lines 62-70); test/fixtures/models-a416790.cjs deep-compares against it —
// never the installed ~/.dsh copy (plan Review Focus #5). Keys: id,name,
// contextWindow,maxOutput,description,vision?,efforts?,responses?,
// reasoningRequired? — defaults and reasoning.* live only in resolveModel() below.
// reasoningRequired: Zen 400s without reasoning_effort (daemon clamps it).
// vision: live-verified; Nemotrons 400 on images, jev/ling/muse unprobed → text.
// responses: /zen/v1/responses only (#44659/#44847, DSH #3957; 500 on chat).
// efforts: out-of-ladder ids are a hard 400; mimo chat 500s on minimal/xhigh/max.
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
const EFFORT_NAMES = { off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'X-High', max: 'Max' }
const EFFORT_DESCRIPTIONS = {
  off: 'No thinking, fastest', minimal: 'Minimal thinking', low: 'Light thinking', medium: 'Moderate thinking',
  high: 'Deep thinking (default)', xhigh: 'Very deep thinking', max: 'Extreme thinking, most quota',
}

const DEFAULT_REASONING = 'high'
const DEFAULT_MAX_TOKENS = 32000
const DEFAULT_CONTEXT_WINDOW = 200000

// Canonical retry-policy config. dsh-llm registers whatever providerRetryPolicy
// returns AS-IS (prepareRoutes never re-resolves adapter-owned policies) and
// dsh-llm-retry reads backoff from the TOP level — the nested form computed
// NaN localDelay (a416790 incident). resolveRetryPolicy below is the only
// source for providerRetryPolicy().
const RETRY_POLICY_CONFIG = {
  mode: 'normal',
  maxRetries: 3,
  retryableCodes: ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE'],
  backoff: { initialDelayMs: 800, maxDelayMs: 8000, jitterRatio: 0.2 },
}

// Host peer: one require feeds both the resolved retry policy and the
// attribution user-agent; standalone (no peer) → both absent.
let dshLlm = null
try { dshLlm = require('@deepseek-ai/dsh-llm') } catch { /* no host peer */ }
const resolveRetryPolicyImpl = dshLlm ? dshLlm.resolveRetryPolicy : null
const attributionHeadersImpl = dshLlm ? dshLlm.attributionHeaders : null

// --- Failure taxonomy --------------------------------------------------------
// DSH honors a failure only when the error OWNS a `code` string AND a
// `failure={message,code,status?}` snapshot (bare code → UNKNOWN → turn dies).
function typedError(failure) {
  const error = new Error(failure.message)
  error.code = failure.code
  error.failure = { ...failure }
  return error
}

function aborted() {
  return typedError({ message: 'OpenCode Zen request aborted by caller', code: 'ABORTED' })
}

function errorText(err) {
  const parts = []
  const seen = new Set()
  let current = err
  while (current !== null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    parts.push(typeof current.message === 'string' && current.message.length > 0 ? current.message : String(current.name || 'error'))
    current = current.cause
  }
  return parts.length === 0 ? String(err) : parts.join(': ')
}

// undici wraps socket failures as `TypeError: fetch failed` + a cause chain
// carrying the errno-style code. First code in the chain wins.
function fetchFailureCode(err) {
  const seen = new Set()
  let current = err
  while (current !== null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    if (typeof current.code === 'string' && current.code.length > 0) return current.code
    current = current.cause
  }
  return undefined
}

// --- Wire serialization ------------------------------------------------------
// DSH blocks → plain OpenAI chat messages; parity with a416790's serializer.

function isImageBlock(block) {
  return block !== null && typeof block === 'object' && block.type === 'image' && block.attachment !== undefined
}

// One durable image block → one wire part; without the attachment service the
// occurrence degrades to stable text instead of silently vanishing.
async function imagePart(block, store) {
  const ref = block.attachment
  if (!store || typeof store.readImage !== 'function') {
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

function flattenText(content) {
  if (Array.isArray(content)) return content.filter((b) => b.type === 'text').map((b) => b.text).join('')
  return typeof content === 'string' ? content : ''
}

function blocksOf(content, type) {
  return Array.isArray(content) ? content.filter((b) => b.type === type) : []
}

// Tool-result images are buffered and folded into the next user slot (OpenAI
// tool messages carry text only); reasoning folds into the assistant message
// (reasoning_content) — never its own role.
async function serializeMessages(messages, systemPrompt, store) {
  const wire = []
  if (systemPrompt) wire.push({ role: 'system', content: systemPrompt })
  let pendingImages = []

  const userContent = async (m) => {
    const parts = []
    if (typeof m.content === 'string' && m.content.length > 0) parts.push({ type: 'text', text: m.content })
    else if (Array.isArray(m.content)) for (const block of m.content) {
      if (block.type === 'text') { if (block.text) parts.push({ type: 'text', text: block.text }) }
      else if (isImageBlock(block)) parts.push(await imagePart(block, store))
    }
    if (pendingImages.length > 0) { parts.push(...pendingImages); pendingImages = [] }
    if (parts.length === 0) return ''
    return parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts
  }

  const flushPendingImages = () => {
    if (pendingImages.length > 0) {
      wire.push({ role: 'user', content: pendingImages })
      pendingImages = []
    }
  }

  const pushToolResult = async (toolCallId, content) => {
    wire.push({ role: 'tool', tool_call_id: toolCallId, content: flattenText(content) || '(no output)' })
    for (const block of Array.isArray(content) ? content : []) {
      if (isImageBlock(block)) pendingImages.push(await imagePart(block, store))
    }
  }

  for (const m of messages || []) {
    if (m.role === 'system') { flushPendingImages(); wire.push({ role: 'system', content: flattenText(m.content) }); continue }
    if (m.role === 'assistant') {
      flushPendingImages()
      const text = flattenText(m.content)
      const reasoning = blocksOf(m.content, 'reasoning').map((b) => b.text).join('')
      const toolCalls = blocksOf(m.content, 'tool-call').map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: b.arguments } }))
      if (text.length === 0 && reasoning.length === 0 && toolCalls.length === 0) continue // empty turn: not legal on the wire
      const msg = { role: 'assistant', content: text }
      if (reasoning) msg.reasoning_content = reasoning
      if (toolCalls.length) msg.tool_calls = toolCalls
      wire.push(msg)
      continue
    }
    if (m.role === 'tool') { await pushToolResult(m.toolCallId, m.content); continue }
    const toolResults = blocksOf(m.content, 'tool-result')
    const text = flattenText(m.content)
    if (text || toolResults.length === 0) {
      const content = await userContent(m)
      if (content !== '') wire.push({ role: 'user', content }) // empty user turns drop; tool results below still travel
    }
    for (const r of toolResults) await pushToolResult(r.toolCallId, r.content)
  }
  flushPendingImages()
  return wire
}

function serializeTools(tools) {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters && typeof t.parameters === 'object' ? t.parameters : { type: 'object', properties: {} } },
  }))
}

// --- SSE framing (transport) -------------------------------------------------
// Split on newlines, yield each `data:` payload's parsed JSON, stop at
// `[DONE]`; comment lines and non-JSON payloads are ignored. Interpreting the
// payloads is Task 4's translator; NO watchdog — timeouts are Task 5's call.
async function* pumpSse(response) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data) continue
        if (data === '[DONE]') return
        try { yield JSON.parse(data) } catch { /* transport ignores bad payloads */ }
      }
    }
  } finally {
    // Cancel (not just release) so an abandoned reader cannot leak the socket.
    try { await reader.cancel() } catch { /* noop */ }
    try { reader.releaseLock() } catch { /* noop */ }
  }
}

// --- Model helpers -----------------------------------------------------------

function findModel(model) {
  return MODELS.find((m) => m.id === model)
}

function effortLevels(meta) {
  const ids = Array.isArray(meta?.efforts) && meta.efforts.length > 0 ? meta.efforts : DEFAULT_EFFORT_IDS
  return ids.map((id) => ({ id, name: EFFORT_NAMES[id] || id, description: EFFORT_DESCRIPTIONS[id] || 'Reasoning effort level' }))
}

// Only wire-verified vision models advertise 'image' to the host's modalities gate.
function staticModelInfo(meta, provider) {
  return { provider, id: meta.id, name: meta.name, description: meta.description, inputModalities: meta.vision === true ? ['text', 'image'] : ['text'] }
}

// Live catalog refresh: GET /v1/models answers ids only — metadata always
// comes from the static table; ANY failure throws and listModels() swallows it.
const LIST_MODELS_TIMEOUT_MS = 2000

async function liveModelInfos(provider) {
  const response = await fetch(`${OPENCODE_ZEN_BASE}/v1/models`, {
    signal: AbortSignal.timeout(LIST_MODELS_TIMEOUT_MS),
  })
  const body = await response.text()
  if (!response.ok) throw new Error(`GET /v1/models → HTTP ${response.status}`)
  const parsed = JSON.parse(body)
  const ids = Array.isArray(parsed?.data)
    ? parsed.data.filter((item) => item && typeof item.id === 'string').map((item) => item.id)
    : []
  if (ids.length === 0) throw new Error('GET /v1/models → no usable model ids')
  return ids.map((id) => {
    const meta = findModel(id)
    return meta ? staticModelInfo(meta, provider) : { provider, id, name: id, inputModalities: ['text'] }
  })
}

// --- Adapter -----------------------------------------------------------------

class OpenCodeZenAdapter {
  constructor(ctx) { this.ctx = ctx }

  providerInfo(provider) { return { id: provider, name: 'OpenCode Zen' } }

  providerRetryPolicy() {
    // RESOLVED (flattened) policy — see RETRY_POLICY_CONFIG; no peer →
    // undefined and the host applies its normal defaults.
    return resolveRetryPolicyImpl ? resolveRetryPolicyImpl(RETRY_POLICY_CONFIG, 'dsh-opencode-zen: retryPolicy') : undefined
  }

  // dsh >= 0.1.2 token meter needs this even without feature checks; this
  // route declares no provider-side image pricing (same as @liustack/modlens).
  imageRequestPricing() { return undefined }

  listModels(provider = PROVIDER) {
    return liveModelInfos(provider).catch(() => MODELS.map((meta) => staticModelInfo(meta, provider)))
  }

  // Table → LlmResolvedModelInfo mapping. Output-only fields derive HERE only:
  //   maxOutput     → defaultMaxTokens    (DEFAULT_MAX_TOKENS when absent)
  //   contextWindow → context.contextWindow (DEFAULT_CONTEXT_WINDOW when absent)
  //   vision        → inputModalities ['text','image'], else ['text']
  //   efforts       → reasoning.efforts as {id,name,description} (default ladder)
  //   (no field)     → reasoning.defaultEffort = DEFAULT_REASONING — sent by the
  //     host for every model; effort CLAMPING and the reasoningRequired/none
  //     rules live in the daemon (zen.ClampEffort, internal/zen/models.go:108).
  // Unknown ids still resolve with every default — no turn fails on metadata.
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
    return { model: await this.resolveModel(provider, model, signal), stream: (options) => this.stream(options) }
  }

  // Task 3 transport: ONE POST to the contract path, `stream:true` only
  // (stream_options is the daemon's, handler.go:204), the dsh-llm attribution
  // user-agent, options.signal wired to fetch. ZERO retries — failures throw.
  // HTTP statuses stay UNMAPPED (raw error carries {status, body} for Task 5);
  // mapped here: ECONNREFUSED → TRANSPORT, fired signal → ABORTED (row 12).
  async *stream(options) {
    const signal = options.signal
    if (signal?.aborted) throw aborted()
    const store = this.ctx?.get?.('attachments')
    const body = {
      model: options.model,
      messages: await serializeMessages(options.messages, options.system, store),
      stream: true,
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
      ...(options.stop !== undefined ? { stop: options.stop } : {}),
      ...(options.reasoningEffort !== undefined ? { reasoning_effort: options.reasoningEffort } : {}),
    }
    const tools = serializeTools(options.tools)
    if (tools) body.tools = tools
    const headers = { 'content-type': 'application/json' }
    if (attributionHeadersImpl) Object.assign(headers, attributionHeadersImpl())
    const apiKey = process.env.OPENCODE_ZEN_API_KEY
    if (apiKey) headers.authorization = `Bearer ${apiKey}`
    const url = `${OPENCODE_ZEN_BASE}/v1/chat/completions`
    let response
    try {
      response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal })
    } catch (error) {
      if (signal?.aborted) throw aborted()
      if (fetchFailureCode(error) === 'ECONNREFUSED') {
        throw typedError({ message: `opencode zen unreachable: POST ${url} (${errorText(error)})`, code: 'TRANSPORT' })
      }
      throw error
    }
    if (!response.ok) {
      // Status mapping is Task 5's: stash raw status + body, throw WITHOUT a code.
      const detail = await response.text().catch(() => '')
      const error = new Error(`opencode zen HTTP ${response.status} on POST ${url}: ${detail.slice(0, 300)}`)
      error.response = { status: response.status, body: detail }
      throw error
    }
    try {
      yield* pumpSse(response)
    } catch (error) {
      if (signal?.aborted) throw aborted()
      throw error
    }
    if (signal?.aborted) throw aborted()
  }
}

// Task 6 wraps registration with the health ping + config-gated `zen-router up
// --detach` (registration happens regardless); so far apply() is registration
// only: no cordis effects, no event subscriptions, no disk-facing stores.
function apply(ctx) {
  ctx.llm.registerAdapter([PROVIDER], new OpenCodeZenAdapter(ctx))
}

module.exports = {
  apply,
  inject,
  name,
  OpenCodeZenAdapter,
  PROVIDER,
  MODELS,
  OPENCODE_ZEN_BASE,
}
