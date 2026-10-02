# dsh-opencode-zen

**Nine free LLMs for DeepSeek Harness, zero config, zero cost.** Brings the OpenCode Zen free tier into your DSH model picker — no signup, no API key, no billing.

---

## Why?

- **Actually free** — the official free tier authenticates with the literal key `public`; no account, no signup, no API key.
- **Nine free models** — Big Pickle, Jev 1.13, two Xiaomi MiMo versions, Muse Spark 1.3, Ling 3.0 Flash Fin, Space Bunny, and two NVIDIA Nemotrons.
- **Install & go** — restart `dsh web` and the `opencode` route appears in the model selector; no configuration needed.
- **CLI disguise** — requests carry the same headers as the official OpenCode CLI (x-opencode-client, session IDs, gate tools), bypassing the FreeTierError introduced on 2026-09-16.
- **Stack quotas** — pairs with dsh-api-key-pool for round-robin rotation across multiple free accounts, automatically.
- **Quota-aware** — built-in 429/5xx backoff and request throttling so you never blow through the free quota.
- **Hang-proof (0.11.0)** — first-event (30s) and body-idle (120s, 300s on Responses models) watchdogs abort dead tunnels instead of stalling the turn forever; abandoned readers cancel their sockets instead of leaking them.
- **Recovers like a first-class provider (0.11.0)** — every failure carries DSH-native codes (`SERVER`, `RATE_LIMIT`, `TIMEOUT`, `TRANSPORT`, `EMPTY_RESPONSE`), so the host retry policy actually fires; a stream that already delivered content is never replayed (no duplicated output).
- **Session-safe retries (0.11.1)** — the registered retry policy is the host's resolved flat shape, so `llm/retry` events serialize cleanly (no turn-killing `carries non-JSON-serializable data`), and a 401 rotates to the next pooled key in-process before giving up.
- **Live-verified effort ladders (0.11.2)** — every reasoning ladder only offers levels the endpoint actually answers: the MiMo endpoints reply a bare 500 to `minimal`/`xhigh`/`max` (live-probed 2026-10-02), so MiMo offers Off/Low/Medium/High and a stale saved `max` clamps to `High` instead of erroring; a 403 that reports the provider's own outage (`Endpoint is unavailable`) is retried as `SERVER` instead of dying as a terminal gate.
- **Salvages truncated streams (0.11.3)** — a gateway that closes cleanly mid-reply after partial text commits the partial answer as a normal `stop` (the same default dsh-llm applies to a stream that ended without a finish) instead of failing the turn over one dropped tail chunk; a tool call left open still fails honestly (`STREAM_TRUNCATED`) rather than dispatching half-written arguments.
- **CLI-parity audit of the whole gateway source (0.11.4)** — cross-checked every request field and error path against `sst/opencode`'s gateway (`zen/v1` handler, rate limiters, CLI `request.ts`): the always-on `x-opencode-session-id` header is now sent and the user agent is the plain `opencode/1.18.34`, byte-for-byte like the real CLI; a long-window 429 (`FreeUsageLimitError`, `retry-after` → midnight UTC) surfaces at once with the reset time instead of sleeping 15s into another 429; a 401 carrying the gateway's `ModelError` (model removed / trial ended) is a terminal `PROVIDER_ERROR` instead of a credential error that pointlessly rotates pool keys; 403 `RegionError`, country and "within OpenCode" client gates name the real reason. Also fixes a latent bug: the `Retry-After` value never reached the delay calculation (it was read from the wrong envelope level), so every rate-limit retry fired at ~950ms regardless of the header.
- **Honest budgets (0.11.0)** — context windows and output caps come from models.dev metadata per model (MiMo caps at 32k output, Muse at 131k), so a request never over-asks the upstream.
- **Full parity** — streaming, reasoning-content passthrough, and tool calls, same experience as paid models.
- **Vision** — pasted images, `read_image`, and image blocks ride real requests on the four models verified to accept image input; every other model stays honest text-only, so DSH degrades images to placeholders instead of hitting provider errors.

## Models (9 free models)

| Model | Context / output | Notes |
|---|---|---|
| `big-pickle` | 200k / 32k | Big Pickle · **vision** |
| `jev-1.13-free` | 200k / 32k | Jev 1.13 · limits unpublished, conservative budget |
| `ling-3.0-flash-fin-free` | 262k / 32k | Ling 3.0 Flash Fin · reasoning + tool calls, daily driver |
| `mimo-v2.5-free` | 200k / 32k | Xiaomi MiMo 2.5 · **vision** · effort ladder Off/Low/Medium/High (Zen 500s on higher levels) |
| `mimo-v2.6-flash-free` | 200k / 32k | Xiaomi MiMo 2.6 Flash · **vision** · effort ladder Off/Low/Medium/High (Zen 500s on higher levels) |
| `muse-spark-1.3-contributor-free` | 1M / 131k | Muse Spark 1.3 Contributor · **routed via `/responses`** (its `/chat/completions` answers with a bare 500) |
| `nemotron-3.5-lightning-free` | 262k / 262k | NVIDIA Nemotron 3.5 Lightning |
| `nemotron-3-ultra-free` | 1M / 128k | NVIDIA Nemotron 3 Ultra |
| `space-bunny-free` | 1M / 524k | Space Bunny · OpenRouter-backed, **reasoning always on** · **vision** |

Context/output budgets follow models.dev metadata (verified against `GET /zen/v1/models` on 2026-10-02); `max_tokens` is clamped per model.

Reasoning effort: `off` / `low` / `high` (default) / `max`, reduced to the ladder the model actually declares — Muse offers `minimal`…`xhigh` and hides `off`/`max`, Space Bunny hides `off`, MiMo serves only `off`/`low`/`medium`/`high` (higher levels 500). A saved effort outside the ladder clamps to the nearest declared level (`max` → `high` on MiMo), so stale configs keep working. `off` sends wire value `none` (omitting the field keeps the provider's thinking on).

> **Note on vision** — `vision: true` in `MODELS` is set only from a passing probe against
> the live Zen wire (a 64×64 red PNG asked "what color?" answered "Red"). Both Nemotrons
> accept text but reject image requests with `400 Upstream request failed: Endpoint is
> unavailable.`; `jev`/`ling`/`muse` were unreachable for text *and* image while probing, so
> they stay text-only until a probe passes. Re-run a probe before flipping a flag.

> **Note on `space-bunny-free`** — this model is not listed in Zen's public model table, but it
> answers requests. It rejects any call without `reasoning_effort`:
> `400 {"message":"Reasoning is mandatory for this endpoint and cannot be disabled."}`.
> The plugin therefore always sends an effort for it (falling back to `high`) and hides the
> `off` option in the model picker. If you hit that error on any other model, the plugin
> version is too old — upgrade to 0.8.0+.

## Installation

```sh
dsh plugin --profile web add github:kyomufs/dsh-opencode-zen
```

Restart `dsh web` → **Settings → Models** → pick provider `opencode` → choose a free model (start with `ling-3.0-flash-fin-free`).

## Configuration (optional — zero config by default)

### Stack multiple accounts

1. Install [dsh-api-key-pool](https://github.com/xiaozhe7772222/dsh-api-key-pool).
2. Add your keys under the `opencode` pool.
3. The plugin picks them up automatically and rotates round-robin.

### Environment variables

Set `OPENCODE_ZEN_API_KEY` or `OPENCODE_GO_API_KEY` before starting `dsh web`.

Nothing configured? It falls back to the official public tier (`public`).

Tuning (defaults are live-tuned, only change them if you know why):

| Variable | Default | Meaning |
|---|---|---|
| `DSH_ZEN_FIRST_EVENT_MS` | `30000` | connect/headers/first-SSE-event watchdog |
| `DSH_ZEN_IDLE_MS` | `120000` | body-idle watchdog for chat models |
| `DSH_ZEN_RESPONSES_IDLE_MS` | `300000` | body-idle watchdog for Responses models (Muse paces slowly) |
| `OPENCODE_ZEN_BASE` | `https://opencode.ai/zen/v1` | wire override, used by the test stand |
| `OPENCODE_ZEN_POOL_FILE` | `$DSH_HOME/profiles/web/plugins/dsh-api-key-pool/pool-config.json` | key-pool file; re-read automatically when its mtime changes |
| `DSH_HOME` | `~/.dsh` | harness home used to locate the default key-pool file |

## How it works

Since 2026-09-16, OpenCode Zen added server-side validation requiring:
1. **Canonical session ID format** — `ses_` + 12 hex timestamp + 14 Base62 characters
2. **CLI disguise headers** — `x-opencode-client: cli`, `x-opencode-session`, `x-session-affinity`, etc.
3. **Agent shape gate** — body must include `bash` and `read` tools

This plugin implements all three, based on the approach from [opencode2dsh](https://github.com/FishBottle7/opencode2dsh).

## Similar plugins

If this plugin doesn't meet your needs, check out these alternatives:

| Plugin | Description | Link |
|---|---|---|
| **opencode2dsh** | Full-featured DSH plugin with IP pool, rotation, and watchdog | [GitHub](https://github.com/FishBottle7/opencode2dsh) |
| **opencode2api** | HTTP proxy that forwards requests to OpenCode (Go binary) | [GitHub](https://github.com/6Kmfi6HP/opencode2api) |
| **dsh-opencode-zen (original)** | Original plugin by xiaozhe7772222 (may be outdated) | [GitHub](https://github.com/xiaozhe7772222/dsh-opencode-zen) |

## Troubleshooting

**Q: `401 \"Model X is not supported\"`?**
A: Zen's free lineup rotates. Model IDs come from `https://opencode.ai/zen/v1/models` — see [zen-free-models](https://github.com/VcDoc/zen-free-models) for the current list.

**Q: `400 \"Reasoning is mandatory for this endpoint and cannot be disabled.\"`?**
A: Upgrade to 0.8.0+. Older versions drop `reasoning_effort` when the effort is set to `off`, which some endpoints (e.g. `space-bunny-free`) reject.

**Q: Model returns 429 Too Many Requests?**
A: The free tier has per-IP rate limits. Wait 30–60 seconds, or install [dsh-api-key-pool](https://github.com/xiaozhe7772222/dsh-api-key-pool) to rotate across multiple keys automatically.

**Q: Model returns 403 FreeTierError?**
A: Make sure you're using version 0.5.0+ of this plugin. Older versions don't include the CLI disguise headers required since 2026-09-16. On current versions a `FreeTierError` after a while of normal usage is the anonymous per-IP quota cooling down — wait a minute or rotate keys with [dsh-api-key-pool](https://github.com/xiaozhe7772222/dsh-api-key-pool).

**Q: `403 {"model":"..."}` (a body that just echoes the model id)?**
A: The anonymous lane refusing this model for your IP right now — per-IP quota, region gate, or model gate. It is deliberately not retried (hammering makes the window longer): wait for the window, switch model, or stack keys via dsh-api-key-pool.

**Q: `HTTP 500 {"type":"error",...,"message":"Internal server error"}`?**
A: Three known causes, all handled: (1) until 0.11.0 it was usually `muse-spark-*` on `/chat/completions` — 0.11.0 routes Responses-only models through `/responses` automatically; (2) the MiMo endpoints answer a bare 500 to `reasoning_effort` levels they don't serve (`minimal`/`xhigh`/`max`) — 0.11.2 only offers levels the id answers and clamps stale saved efforts, so a 500 that appears at one specific effort is gone after updating; (3) otherwise it is upstream flakiness — the plugin retries once in-process and DSH retries `SERVER` failures up to 3 times with backoff (the `Retry delay: Nms` line is that host retry firing).

**Q: `stream ended without a terminal event after partial output`?**
A: Pre-0.11.3 the plugin failed the whole turn when the gateway closed a response cleanly before `finish`/`[DONE]`. 0.11.3+ salvages it: a partial **text/reasoning** reply commits as a normal `stop` (dsh-llm does the same for streams ended without a finish) and the turn continues; if a **tool call** was still open it still fails as `STREAM_TRUNCATED`, because half-written tool arguments must never dispatch. Output already delivered is never replayed.

**Q: The turn hangs / `terminated UNKNOWN`?**
A: Both are pre-0.11.0 bugs: no body watchdog (a tunnel could stand silently forever) and failures without DSH-native codes (so the host showed `UNKNOWN` and never retried). Update to 0.11.0+: dead streams die within 30s/120s as `TIMEOUT`, socket deaths surface as `TRANSPORT` and the host retries them.

**Q: `opencode` provider doesn't appear in model selector?**
A: Restart `dsh web` fully (not just refresh). Verify installation with `dsh plugin --profile web list`.

**Q: Which DSH versions are supported?**
A: DSH 0.8.0+ with the `ctx.llm.registerAdapter` API. Older versions may need manual route registration.

**Q: Are these models really free forever?**
A: They use OpenCode Zen's official public free tier. Service availability and quota limits are subject to OpenCode Zen's policies — this plugin is just a client adapter.

## Credits

- Original plugin: [xiaozhe7772222/dsh-opencode-zen](https://github.com/xiaozhe7772222/dsh-opencode-zen)
- CLI disguise approach: [FishBottle7/opencode2dsh](https://github.com/FishBottle7/opencode2dsh)
- Session header injection: [dsh-opencode-session](https://github.com/xiaozhe7772222/dsh-opencode-session)

## License

MIT