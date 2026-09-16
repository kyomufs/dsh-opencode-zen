'use strict'
/**
 * dsh-opencode-zen — OpenCode Zen free models + session header fix
 *
 * Combined plugin that:
 * 1. Registers OpenCode Zen free models as a DSH LLM provider
 * 2. Injects x-opencode-session header to fix 400 MissingSessionID errors
 */

const { readFileSync, existsSync } = require('node:fs')
const { appendFile } = require('node:fs/promises')
const { join } = require('node:path')
const { homedir } = require('node:os')
const { AsyncLocalStorage } = require('node:async_hooks')
const { randomUUID } = require('node:crypto')

const name = 'dsh-opencode-zen'
const inject = ['llm']

const PROVIDER = 'opencode'
const OPENCODE_BASE = 'https://opencode.ai/zen/v1'
const OPENCODE_UA = 'opencode/1.18.18 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14'
const POOL_FILE = join(homedir(), '.dsh', 'profiles', 'web', 'plugins', 'dsh-api-key-pool', 'pool-config.json')

const MODELS = [
  { id: 'deepseek-v4-flash-free', name: 'DeepSeek V4 Flash (Free)', contextWindow: 200000, description: 'OpenCode Zen free: reasoning + tool calls, daily driver' },
  { id: 'mimo-v2.5-free', name: 'MiMo 2.5 (Free)', contextWindow: 200000, description: 'OpenCode Zen free' },
  { id: 'hy3-free', name: 'Hunyuan 3 (Free)', contextWindow: 200000, description: 'OpenCode Zen free (Tencent Hunyuan)' },
  { id: 'nemotron-3-ultra-free', name: 'Nemotron 3 Ultra (Free)', contextWindow: 131072, description: 'OpenCode Zen free (NVIDIA)' },
  { id: 'nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning (Free)', contextWindow: 131072, description: 'OpenCode Zen free (NVIDIA)' },
  { id: 'laguna-s-2.1-free', name: 'Laguna S 2.1 (Free)', contextWindow: 200000, description: 'OpenCode Zen free' },
]

const REASONING_LEVELS = [
  { id: 'off', name: 'Off', description: 'No thinking, fastest' },
  { id: 'low', name: 'Low', description: 'Light thinking' },
  { id: 'high', name: 'High', description: 'Deep thinking (default)' },
  { id: 'max', name: 'Max', description: 'Extreme thinking, most quota' },
]

const DEFAULT_REASONING = 'high'
const DEFAULT_MAX_TOKENS = 128000
const DEFAULT_CONTEXT_WINDOW = 200000
const MAX_REQUEST_ATTEMPTS = 2

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

// --- OpenCode Zen adapter (original dsh-opencode-zen) ---

function log(ctx, level, msg) {
  try { ctx.logger[level](`[dsh-opencode-zen] ${msg}`) } catch { /* noop */ }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

let _poolKeys = null
let _poolIdx = 0
function loadPoolKeys() {
  if (_poolKeys) return _poolKeys
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
  _poolKeys = dedup.length > 0 ? dedup : ['public']
  return _poolKeys
}

function resolveApiKey() {
  const keys = loadPoolKeys()
  const key = keys[_poolIdx % keys.length]
  _poolIdx = (_poolIdx + 1) % keys.length
  return key
}

function serializeMessages(messages, systemPrompt) {
  const wire = []
  if (systemPrompt) wire.push({ role: 'system', content: systemPrompt })
  for (const m of messages || []) {
    const role = m.role
    if (role === 'system') {
      wire.push({ role: 'system', content: flattenText(m.content) })
      continue
    }
    if (role === 'assistant') {
      const text = flattenText(m.content)
      const reasoning = blocksOf(m.content, 'reasoning').map((b) => b.text).join('')
      const toolCalls = blocksOf(m.content, 'tool-call').map((b) => ({
        id: b.id, type: 'function', function: { name: b.name, arguments: b.arguments },
      }))
      const msg = { role: 'assistant', content: text }
      if (reasoning) msg.reasoning_content = reasoning
      if (toolCalls.length) msg.tool_calls = toolCalls
      wire.push(msg)
      continue
    }
    const toolResults = blocksOf(m.content, 'tool-result')
    const text = flattenText(m.content)
    if (text || toolResults.length === 0) wire.push({ role: 'user', content: text })
    for (const r of toolResults) {
      wire.push({ role: 'tool', tool_call_id: r.toolCallId, content: flattenText(r.content) || '(no output)' })
    }
  }
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
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
}

async function* parseSse(response) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
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
        if (data === '[DONE]') return
        try { yield JSON.parse(data) } catch { /* ignore bad line */ }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

async function* translateStream(rawChunks, estimateInput) {
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
          yield { type: 'tool-call-delta', index: block.index, name: block.name || '', argumentsDelta: fn.arguments }
        }
      }
      if (chunk.finish_reason === 'length') finish = { kind: 'max-tokens' }
    }
    if (chunk.usage) usage = mapUsage(chunk.usage)
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

class OpenCodeZenAdapter {
  constructor(ctx) { this.ctx = ctx }
  providerInfo(provider) { return { id: provider, name: 'OpenCode Zen' } }
  providerRetryPolicy() {
    return {
      mode: 'normal',
      maxRetries: 2,
      retryableCodes: ['RATE_LIMITED', 'TIMEOUT', 'TRANSPORT'],
      backoff: { initialDelayMs: 800, maxDelayMs: 5000, jitterRatio: 0.1 },
    }
  }
  listModels() {
    return Promise.resolve(MODELS.map((m) => ({ provider: PROVIDER, id: m.id, name: m.name, description: m.description, inputModalities: ['text'] })))
  }
  resolveModel(provider, model) {
    const found = MODELS.find((m) => m.id === model)
    const reasoning = {
      efforts: REASONING_LEVELS,
      defaultEffort: DEFAULT_REASONING,
    }
    return Promise.resolve({
      provider,
      id: model,
      name: found?.name || model,
      ...(found?.description ? { description: found.description } : {}),
      inputModalities: ['text'],
      context: { contextWindow: found?.contextWindow || DEFAULT_CONTEXT_WINDOW },
      defaultMaxTokens: DEFAULT_MAX_TOKENS,
      reasoning,
    })
  }

  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    }
  }

  async *stream(options) {
    const { model, messages, system, tools, maxTokens, reasoningEffort, temperature, signal } = options

    const effort = reasoningEffort && reasoningEffort !== 'off' ? reasoningEffort : undefined
    const wireMessages = serializeMessages(messages, system)
    const wireTools = serializeTools(tools)

    const body = {
      model,
      messages: wireMessages,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: maxTokens || DEFAULT_MAX_TOKENS,
      top_p: 0.95,
      ...(temperature !== undefined ? { temperature } : {}),
      ...(wireTools ? { tools: wireTools, tool_choice: 'auto' } : {}),
      ...(effort ? { reasoning_effort: effort } : {}),
    }

    let lastError = null
    for (let attempt = 0; attempt < MAX_REQUEST_ATTEMPTS; attempt++) {
      if (signal?.aborted) throw aborted()
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), options.timeoutMs || 60000)
        const onAbort = () => controller.abort()
        if (signal) signal.addEventListener('abort', onAbort)

        let response
        try {
          response = await fetch(`${OPENCODE_BASE}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${resolveApiKey()}`,
              'User-Agent': OPENCODE_UA,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          })
        } finally {
          clearTimeout(timer)
          if (signal) signal.removeEventListener('abort', onAbort)
        }

        if (!response.ok) {
          const raw = await response.text().catch(() => '')
          const code = response.status === 429 ? 'RATE_LIMITED' : response.status >= 500 ? 'TRANSPORT' : 'PROVIDER_ERROR'
          lastError = new Error(`OpenCode Zen HTTP ${response.status}: ${raw.slice(0, 300)}`)
          lastError.code = code
          if (code !== 'RATE_LIMITED' && code !== 'TRANSPORT') throw lastError
          await sleep(400 * (attempt + 1))
          continue
        }

        yield* translateStream(parseSse(response), () => JSON.stringify(wireMessages))
        return
      } catch (err) {
        if (signal?.aborted) throw aborted()
        if (err.name === 'AbortError' && !options.timeoutMs) throw err
        lastError = err
        if (attempt < MAX_REQUEST_ATTEMPTS - 1) await sleep(400 * (attempt + 1))
      }
    }
    throw lastError || new Error('OpenCode Zen request failed')
  }
}

function aborted() {
  const e = new Error('OpenCode Zen request aborted by caller')
  e.code = 'ABORTED'
  return e
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

module.exports = { apply, inject, name, OpenCodeZenAdapter, PROVIDER, MODELS, resolveApiKey }
