'use strict'

// dsh-opencode-zen — thin adapter for the local zen-router daemon (plan 2026-10-07-dsh-opencode-zen-thin.md); loopback only, OPENCODE_ZEN_API_KEY optional.

const name = 'dsh-opencode-zen'
const inject = ['llm']

const PROVIDER = 'opencode'

const OPENCODE_ZEN_BASE = process.env.OPENCODE_ZEN_BASE || 'http://127.0.0.1:8787' // Transport base — NO path: the adapter appends /v1/chat/completions and /v1/models itself; tests point it here via the env var

// --- Static model table: VERBATIM 9-entry copy of `git show a416790:lib/index.js` (lines 62-70), deep-compared by test/fixtures/models-a416790.cjs (plan Review Focus #5); flag/effort semantics live in resolveModel() below.
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

// Canonical retry policy: dsh-llm registers providerRetryPolicy() output AS-IS and dsh-llm-retry reads TOP-level backoff (nested shape → NaN localDelay, a416790); resolveRetryPolicy() below is the only flattener.
const RETRY_POLICY_CONFIG = {
  mode: 'normal',
  maxRetries: 3,
  retryableCodes: ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE'],
  backoff: { initialDelayMs: 800, maxDelayMs: 8000, jitterRatio: 0.2 },
}

let dshLlm = null; try { dshLlm = require('@deepseek-ai/dsh-llm') } catch { /* no host peer */ }
const resolveRetryPolicyImpl = dshLlm ? dshLlm.resolveRetryPolicy : null
const attributionHeadersImpl = dshLlm ? dshLlm.attributionHeaders : null
const { QUOTA_EXCEEDED_CODE = 'QUOTA', INVALID_CREDENTIAL_CODE = 'INVALID_CREDENTIAL', EMPTY_RESPONSE_CODE = 'EMPTY_RESPONSE' } = dshLlm || {} // dsh-llm exports where they exist, else host literal (DEFAULT_RETRYABLE_CODES mixes both forms)

// --- Failure taxonomy: DSH honors a failure only when it OWNS a `code` string AND a `failure={message,code,status?}` snapshot (bare code → UNKNOWN → turn dies).
function typedError(failure) {
  const error = new Error(failure.message)
  error.code = failure.code
  error.failure = { ...failure }
  return error
}

function aborted() { return typedError({ message: 'OpenCode Zen request aborted by caller', code: 'ABORTED' }) }

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

const QUOTA_429_TYPES = ['FreeUsageLimitError', 'GoUsageLimitError', 'BlackUsageLimitError']
function httpFailure(status, detail, retryAfter) { // plan:128-163 table — topmost match wins, type-first on 401/429; 400/403/404/405/413 + unmatched status → PROVIDER_ERROR safety; Retry-After (whole seconds × 1000) rides both 429 rows
  let type
  try { type = JSON.parse(detail)?.error?.type } catch { /* non-JSON body → bare status */ }
  let code
  if (status === 401) code = type === 'ModelError' ? 'PROVIDER_ERROR' : INVALID_CREDENTIAL_CODE // the 401 trap
  else if (status === 429) code = QUOTA_429_TYPES.includes(type) ? QUOTA_EXCEEDED_CODE : 'RATE_LIMIT'
  else code = status >= 500 ? 'SERVER' : 'PROVIDER_ERROR'
  const failure = { code, status }
  if (status === 429 && Number(retryAfter) > 0) failure.providerRetryAfterMs = Number(retryAfter) * 1000
  return failure
}

// --- Wire serialization: DSH blocks → plain OpenAI chat messages (parity with a416790's serializer). ---

function isImageBlock(block) {
  return block !== null && typeof block === 'object' && block.type === 'image' && block.attachment !== undefined
}

async function imagePart(block, store) { // One durable image block → one wire part; without the attachment service it degrades to stable text instead of vanishing
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

async function serializeMessages(messages, systemPrompt, store) { // Tool-result images fold into the next user slot (tool messages carry text only); reasoning folds into the assistant message, never its own role
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

// --- SSE framing (transport): split on newlines, yield each `data:` payload's parsed JSON, stop at `[DONE]`; comment/non-JSON lines ignored, interpretation is translate() below; NO watchdog (Task 5). ---
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
    try { await reader.cancel() } catch { /* noop */ } // cancel, not just release: an abandoned reader must not leak the socket
    try { reader.releaseLock() } catch { /* noop */ }
  }
}

// --- SSE → StreamChunk translation (Task 4) ---------------------------------
// Blocks open on the first delta of a kind and close on kind switch, finish frame or termination; `finish` is deferred to termination so `usage` always precedes it and nothing follows. Premature close AFTER content salvages the open blocks (partial carried) before `finish`; BEFORE content the raw read error propagates (row 13 — Task 5 maps it).
async function* translate(source, signal) {
  let nextIndex = 0, open = null, started = false, usageSent = false, finishKind = null
  const closeBlock = () => {
    if (!open) return null
    const b = open; open = null
    return b.kind === 'tool-call'
      ? { type: 'block-end', index: b.index, block: { type: 'tool-call', id: b.id, name: b.name, arguments: b.args } }
      : { type: 'block-end', index: b.index, block: { type: b.kind, text: b.text } }
  }
  const openBlock = (out, kind, blockType, wireIndex) => {
    if (open && open.kind === kind && open.wireIndex === wireIndex) return
    const ended = closeBlock(); if (ended) out.push(ended)
    open = { kind, index: nextIndex++, text: '', args: '', wireIndex }
    out.push({ type: 'block-start', index: open.index, blockType }); started = true
  }
  try {
    for await (const frame of source) {
      const out = []
      if (!usageSent && frame && typeof frame.usage === 'object' && frame.usage !== null) {
        const raw = frame.usage, cached = raw.prompt_tokens_details?.cached_tokens || 0
        const usage = { inputTokens: Math.max(0, (raw.prompt_tokens || 0) - cached), outputTokens: raw.completion_tokens || 0, ...(typeof raw.total_tokens === 'number' ? { totalTokens: raw.total_tokens } : {}), ...(cached > 0 ? { cacheReadTokens: cached } : {}) }
        out.push({ type: 'usage', usage }); usageSent = true
      }
      if (Array.isArray(frame?.choices) && frame.choices[0]) {
        const delta = frame.choices[0].delta || {}
        for (const [kind, text] of [['reasoning', delta.reasoning_content], ['text', delta.content]]) {
          if (typeof text !== 'string' || !text) continue
          openBlock(out, kind, kind); open.text += text
          out.push({ type: `${kind}-delta`, index: open.index, text })
        }
        for (const call of delta.tool_calls || []) {
          openBlock(out, 'tool-call', 'tool-call', call.index)
          if (typeof call.id === 'string') open.id = call.id
          const name = call.function?.name
          if (typeof name === 'string') open.name = name
          const piece = typeof call.function?.arguments === 'string' ? call.function.arguments : ''
          open.args += piece
          out.push({ type: 'tool-call-delta', index: open.index, id: open.id, argumentsDelta: piece, ...(typeof name === 'string' ? { name } : {}) })
        }
        const finishReason = frame.choices[0].finish_reason
        if (finishReason) {
          const ended = closeBlock(); if (ended) out.push(ended)
          finishKind = { stop: 'stop', length: 'max-tokens', tool_calls: 'tool-calls' }[finishReason] || 'stop'
        }
      }
      if (out.length > 0) yield* out
    }
  } catch (error) {
    if (signal?.aborted || !started) throw error // abort → ABORTED (row 12); pre-content death → raw (row 13)
  }
  const tail = closeBlock() // salvage pairs every open block BEFORE finish
  if (tail) yield tail
  yield { type: 'finish', reason: { kind: finishKind || 'stop' } }
}

// --- Model helpers -----------------------------------------------------------

function findModel(model) {
  return MODELS.find((m) => m.id === model)
}

function effortLevels(meta) {
  const ids = Array.isArray(meta?.efforts) && meta.efforts.length > 0 ? meta.efforts : DEFAULT_EFFORT_IDS
  return ids.map((id) => ({ id, name: EFFORT_NAMES[id] || id, description: EFFORT_DESCRIPTIONS[id] || 'Reasoning effort level' }))
}

function staticModelInfo(meta, provider) {
  return { provider, id: meta.id, name: meta.name, description: meta.description, inputModalities: meta.vision === true ? ['text', 'image'] : ['text'] }
}

// Live catalog refresh: GET /v1/models answers ids only — metadata always comes from the static table; ANY failure throws and listModels() swallows it.
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
    return resolveRetryPolicyImpl ? resolveRetryPolicyImpl(RETRY_POLICY_CONFIG, 'dsh-opencode-zen: retryPolicy') : undefined // no peer → undefined, host defaults apply
  }

  imageRequestPricing() { return undefined } // dsh >= 0.1.2 token meter needs this even without feature checks; no provider-side image pricing

  listModels(provider = PROVIDER) {
    return liveModelInfos(provider).catch(() => MODELS.map((meta) => staticModelInfo(meta, provider)))
  }

  // Table → LlmResolvedModelInfo; output-only fields derive HERE only: maxOutput → defaultMaxTokens, contextWindow → context.contextWindow, vision → inputModalities, efforts → reasoning.efforts, absent → DEFAULT_*; effort clamping lives in the daemon (zen.ClampEffort, internal/zen/models.go:108); unknown ids still resolve with defaults.
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

  // Task 3 transport: ONE POST to the contract path, `stream:true` only, dsh-llm attribution user-agent, options.signal → fetch, ZERO retries. Task 5 throw sites: no HTTP response → TRANSPORT, status/type/Retry-After → httpFailure(), stream death pre-content → TIMEOUT, clean zero-content end → EMPTY_RESPONSE, fired signal → ABORTED (row 12).
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
      throw typedError({ message: `opencode zen unreachable: POST ${url} (${errorText(error)})`, code: 'TRANSPORT' })
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => ''); if (signal?.aborted) throw aborted() // abort during the error-body read is still row 12 (fifth phase)
      throw typedError({ message: `opencode zen HTTP ${response.status} on POST ${url}: ${detail.slice(0, 300)}`, ...httpFailure(response.status, detail, response.headers.get('retry-after')) })
    }
    let sawContent = false
    const held = []
    try {
      for await (const chunk of translate(pumpSse(response), signal)) {
        if (chunk.type !== 'usage' && chunk.type !== 'finish') sawContent = true
        held.push(chunk)
        if (sawContent) yield* held.splice(0)
      }
    } catch (error) {
      if (signal?.aborted) throw aborted()
      throw typedError({ message: `opencode zen stream died before any content on POST ${url} (${errorText(error)})`, code: 'TIMEOUT', status: response.status })
    }
    if (signal?.aborted) throw aborted()
    if (!sawContent) throw typedError({ message: `opencode zen terminated with zero content on POST ${url}`, code: EMPTY_RESPONSE_CODE, status: response.status })
  }
}

function apply(ctx) { // apply() registers only; Task 6 wraps it with the health ping + config-gated `zen-router up --detach`
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
