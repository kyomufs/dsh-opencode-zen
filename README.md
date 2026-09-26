# dsh-opencode-zen

**Seven free LLMs for DeepSeek Harness, zero config, zero cost.** Brings the OpenCode Zen free tier into your DSH model picker — no signup, no API key, no billing.

---

## Why?

- **Actually free** — the official free tier authenticates with the literal key `public`; no account, no signup, no API key.
- **Seven free models** — LongCat 2.5 Preview, ZenSpace Bunny, Xiaomi MiMo 2.6 Flash, Muse Spark 1.3, Ling 3.0 Flash Fin, and two NVIDIA Nemotrons.
- **Install & go** — restart `dsh web` and the `opencode` route appears in the model selector; no configuration needed.
- **CLI disguise** — requests carry the same headers as the official OpenCode CLI (x-opencode-client, session IDs, gate tools), bypassing the FreeTierError introduced on 2026-09-16.
- **Stack quotas** — pairs with dsh-api-key-pool for round-robin rotation across multiple free accounts, automatically.
- **Quota-aware** — built-in 429/5xx backoff and request throttling so you never blow through the free quota.
- **Full parity** — streaming, reasoning-content passthrough, and tool calls, same experience as paid models.

## Models (7 free models)

| Model | Context window | Notes |
|---|---|---|
| `longcat-2.5-preview-free` | 200k | LongCat 2.5 Preview |
| `zenspace-bunny-free` | 200k | ZenSpace Bunny |
| `mimo-v2.6-flash-free` | 200k | Xiaomi MiMo 2.6 Flash |
| `muse-spark-1.3-contributor-free` | 200k | Muse Spark 1.3 Contributor |
| `ling-3.0-flash-fin-free` | 200k | Ling 3.0 Flash Fin · reasoning + tool calls, daily driver |
| `nemotron-3.5-lightning-free` | 131,072 | NVIDIA Nemotron 3.5 Lightning |
| `nemotron-3-ultra-free` | 131,072 | NVIDIA Nemotron 3 Ultra |

Reasoning effort: `off` / `low` / `high` (default) / `max`.

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

**Q: Model returns 429 Too Many Requests?**
A: The free tier has per-IP rate limits. Wait 30–60 seconds, or install [dsh-api-key-pool](https://github.com/xiaozhe7772222/dsh-api-key-pool) to rotate across multiple keys automatically.

**Q: Model returns 403 FreeTierError?**
A: Make sure you're using version 0.5.0+ of this plugin. Older versions don't include the CLI disguise headers required since 2026-09-16.

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
