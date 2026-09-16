# dsh-opencode-zen

**Six free LLMs for DeepSeek Harness, zero config, zero cost.** Brings the OpenCode Zen free tier into your DSH model picker — no signup, no API key, no billing.

[中文说明](README.zh.md)

---

## Why?

The conversation you're reading right now is powered by this plugin: **DeepSeek V4 Flash on the free tier, for free.**

- 💰 **Actually free** — the official free tier authenticates with the literal key `public`; no account, no signup, no API key.
- 🧮 **Six free models** — DeepSeek V4 Flash, Xiaomi MiMo, Tencent Hunyuan, two NVIDIA Nemotrons, and Laguna S 2.1.
- ⚡ **Install & go** — restart `dsh web` and the `opencode` route appears in the model selector; no configuration needed.
- 🔑 **Stack quotas** — pairs with dsh-api-key-pool for round-robin rotation across multiple free accounts, automatically.
- 🛡️ **Quota-aware** — built-in 429/5xx backoff and request throttling so you never blow through the free quota.
- 🧠 **Full parity** — streaming, reasoning-content passthrough, and tool calls, same experience as paid models.

## Models (6 free models)

| Model | Context window | Notes |
|---|---|---|
| `deepseek-v4-flash-free` | 200k | DeepSeek V4 Flash · reasoning + tool calls, daily driver |
| `mimo-v2.5-free` | 200k | Xiaomi MiMo 2.5 |
| `hy3-free` | 200k | Tencent Hunyuan |
| `nemotron-3-ultra-free` | 131,072 | NVIDIA Nemotron 3 Ultra |
| `nemotron-3.5-lightning-free` | 131,072 | NVIDIA Nemotron 3.5 Lightning |
| `laguna-s-2.1-free` | 200k | Laguna S 2.1 |

Reasoning effort: `off` / `low` / `high` (default) / `max`.

## Installation

```sh
dsh plugin --profile web add github:xiaozhe7772222/dsh-opencode-zen
```

Restart `dsh web` → **Settings → Models** → pick provider `opencode` → choose a free model (start with `deepseek-v4-flash-free`).

## Configuration (optional — zero config by default)

### Stack multiple accounts

1. Install [dsh-api-key-pool](https://github.com/xiaozhe7772222/dsh-api-key-pool).
2. Add your keys under the `opencode` pool.
3. The plugin picks them up automatically and rotates round-robin.

### Environment variables

Set `OPENCODE_ZEN_API_KEY` or `OPENCODE_GO_API_KEY` before starting `dsh web`.

Nothing configured? It falls back to the official public tier (`public`).

## Troubleshooting

**Q: Model returns 429 Too Many Requests?**
A: The free tier has per-IP rate limits. Wait 30–60 seconds, or install [dsh-api-key-pool](https://github.com/xiaozhe7772222/dsh-api-key-pool) to rotate across multiple keys automatically.

**Q: `opencode` provider doesn't appear in model selector?**
A: Restart `dsh web` fully (not just refresh). Verify installation with `dsh plugin --profile web list`.

**Q: Which DSH versions are supported?**
A: DSH 0.8.0+ with the `ctx.llm.registerAdapter` API. Older versions may need manual route registration.

**Q: Are these models really free forever?**
A: They use OpenCode Zen's official public free tier. Service availability and quota limits are subject to OpenCode Zen's policies — this plugin is just a client adapter.

## How it works

Registers an `opencode` LLM provider route via `ctx.llm.registerAdapter(['opencode'], adapter)`, exposing the OpenCode Zen free models to session models and sub-agents alike.

## License

MIT
