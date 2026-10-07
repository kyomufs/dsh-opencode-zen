'use strict'

// dsh-opencode-zen — thin adapter for the local zen-router daemon.
// Plan: zen-router docs/superpowers/plans/2026-10-07-dsh-opencode-zen-thin.md
//
// Shipped incrementally with the plan:
//   Task 2 (this commit) — plugin registration, the static MODELS table, and
//   the adapter shell: providerInfo, providerRetryPolicy,
//   imageRequestPricing, listModels (static table + live-id refresh),
//   resolveModel, prepareCall — plus a minimal stream() stub that only posts
//   the contract path and maps the connection-refused fragment.
//   Task 3  — stream() transport (serializer, attribution, zero retry loop).
//   Task 4  — SSE → StreamChunk translation. Task 5 — the error mapping table.
//   Task 6  — apply() health ping + config-gated daemon autostart.
//
// All traffic targets the local daemon over loopback; the inbound lane has no
// auth check, so OPENCODE_ZEN_API_KEY is accepted but never required.

const name = 'dsh-opencode-zen'
const inject = ['llm']

const PROVIDER = 'opencode'

// Transport base — NO path: the adapter appends /v1/chat/completions
// (Task 3) and /v1/models (listModels refresh) itself. Tests point this at
// loopback fixtures via the same env var.
const OPENCODE_ZEN_BASE = process.env.OPENCODE_ZEN_BASE || 'http://127.0.0.1:8787'

// --- Static model table ------------------------------------------------------
// VERBATIM copy of the 9-entry table from `git show a416790:lib/index.js`
// (lines 62-70); extracted ONCE at test-authoring time into the committed
// parity snapshot test/fixtures/models-a416790.cjs, which the suite deep-
// compares against — never the installed ~/.dsh copy (plan Review Focus #5).
// Entry keys: id,name,contextWindow,maxOutput,description,vision?,efforts?,
// responses?,reasoningRequired?. NO defaultMaxTokens and NO reasoning.* on
// entries — those exist only in resolveModel() OUTPUT (mapping documented
// next to resolveModel below).
//
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

// Canonical retry-policy config. dsh-llm registers whatever providerRetryPolicy
// returns AS-IS (prepareRoutes never runs resolveRetryPolicy on adapter-owned
// policies), and dsh-llm-retry reads initialDelayMs/maxDelayMs/jitterRatio from
// the TOP level of that object. Returning the nested `backoff` form verbatim
// made localDelay compute undefined * 1 = NaN, which then failed the host's
// lossless-JSON snapshot ("llm/retry carries non-JSON-serializable data") and
// killed the whole turn. resolveRetryPolicy produces the flattened runtime
// shape — and it is the ONLY source for providerRetryPolicy() (below).
const RETRY_POLICY_CONFIG = {
  mode: 'normal',
  maxRetries: 3,
  retryableCodes: ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE'],
  backoff: { initialDelayMs: 800, maxDelayMs: 8000, jitterRatio: 0.2 },
}

let resolveRetryPolicyImpl = null
try {
  // Present whenever the host loads this plugin (peer dependency). Standalone
  // runs without the peer report NO policy (providerRetryPolicy() → undefined,
  // the host then applies its normal defaults) — deliberately no hand-flattened
  // fallback: resolveRetryPolicy is the single source, so the config above can
  // never drift from what dsh-llm-retry actually consumes.
  resolveRetryPolicyImpl = require('@deepseek-ai/dsh-llm').resolveRetryPolicy
} catch { /* no host peer: report undefined */ }

// --- Failure taxonomy --------------------------------------------------------
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

// undici wraps every socket failure as `TypeError: fetch failed` + a cause
// chain carrying the errno-style code (ECONNREFUSED / UND_ERR_SOCKET / …).
// First code in the chain wins.
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

// --- Model helpers -----------------------------------------------------------

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

// listModels() entry for a static-table row. DSH gates read_image and image
// passthrough on the declared modalities, so only models verified against the
// Zen wire (see `vision` in MODELS) advertise 'image'.
function staticModelInfo(meta, provider) {
  return {
    provider,
    id: meta.id,
    name: meta.name,
    description: meta.description,
    inputModalities: meta.vision === true ? ['text', 'image'] : ['text'],
  }
}

// Live catalog refresh: GET ${OPENCODE_ZEN_BASE}/v1/models answers
// {"object":"list","data":[{"id": …}]}. The wire answers ids only — metadata
// always comes from the static table above, and an id the table does not know
// gets a conservative placeholder. ANY failure (daemon down, non-2xx, non-JSON,
// wrong/empty shape, mid-body close, hang past the timeout) throws here and is
// swallowed by listModels() below: the refresh never rejects.
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
    // Codes must match dsh-llm's taxonomy (RATE_LIMIT, SERVER, TIMEOUT,
    // TRANSPORT, EMPTY_RESPONSE). The returned value must be the RESOLVED
    // (flattened) policy — see RETRY_POLICY_CONFIG for the NaN-delay incident;
    // with no peer loaded this reports undefined and the host falls back to
    // its normal defaults.
    return resolveRetryPolicyImpl ? resolveRetryPolicyImpl(RETRY_POLICY_CONFIG, 'dsh-opencode-zen: retryPolicy') : undefined
  }

  // dsh >= 0.1.2 token meter calls this with no feature check. Adapters that
  // do not extend the LlmAdapter base class must supply it themselves; this
  // route declares no provider-side image pricing, so the meter keeps its
  // neutral estimate (same approach as @liustack/modlens).
  imageRequestPricing() { return undefined }

  // Static table + live-id refresh. The refresh swallows ALL errors and falls
  // back to the static table, so this method NEVER rejects.
  listModels(provider = PROVIDER) {
    return liveModelInfos(provider).catch(() => MODELS.map((meta) => staticModelInfo(meta, provider)))
  }

  // Table → LlmResolvedModelInfo mapping. The table NEVER carries output-only
  // fields; they are derived here and only here:
  //   maxOutput        → defaultMaxTokens   (DEFAULT_MAX_TOKENS when absent)
  //   contextWindow    → context.contextWindow (DEFAULT_CONTEXT_WINDOW when absent)
  //   vision           → inputModalities ['text','image'], else ['text']
  //   efforts          → reasoning.efforts as {id,name,description}
  //                      (DEFAULT_EFFORT_IDS ladder when absent)
  //   (no table field) → reasoning.defaultEffort = DEFAULT_REASONING — the
  //                      host sends it for every model; per-wire clamping and
  //                      the reasoningRequired/none rules live in Task 3's
  //                      request builder, which reads those table flags.
  // An unknown id still resolves (name falls back to the id) with every
  // budget/window/effort default — the host never fails a turn on metadata.
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

  // Task-2 stub. The POST contract path fires (method + path are observable),
  // but SSE translation (Task 4) and the mapping table (Task 5) are not here
  // yet. The ONE mapped fragment is the no-HTTP-response socket failure
  // ECONNREFUSED → typed TRANSPORT (the pre-existing connection-refused
  // contract); resets (UND_ERR_SOCKET), every HTTP status and every SSE
  // outcome stay UNMAPPED and surface as plain errors — those rows stay RED
  // until Tasks 4/5. Zero in-process retries: one attempt, failures throw.
  async *stream(options) {
    const url = `${OPENCODE_ZEN_BASE}/v1/chat/completions`
    let response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Placeholder body: the DSH-blocks → chat-message serializer ships in
        // Task 3. `stream_options` is never sent (plan Task 3).
        body: JSON.stringify({ model: options.model, messages: [], stream: true }),
        signal: options.signal,
      })
    } catch (error) {
      if (fetchFailureCode(error) === 'ECONNREFUSED') {
        throw typedError({ message: `opencode zen unreachable: POST ${url} (${errorText(error)})`, code: 'TRANSPORT' })
      }
      throw error
    }
    // Discard the body (nothing translates it yet) so the fixture socket can
    // close cleanly, then surface the not-implemented failure.
    await response.body?.cancel().catch(() => {})
    throw new Error(`stream() translation lands in Plan 3 Tasks 3-5 — stub received HTTP ${response.status} from ${url}`)
  }
}

// Task 6 wraps registration with the daemon health ping + config-gated
// `zen-router up --detach`; registration happens REGARDLESS of the ping
// result. At Task 2 apply() is registration and nothing else: no cordis
// effects (the global fetch patch is gone), no event subscriptions, no
// disk-facing stores.
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
