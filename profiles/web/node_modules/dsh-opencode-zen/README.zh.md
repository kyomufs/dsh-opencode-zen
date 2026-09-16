# dsh-opencode-zen

**0 元接入 6 个免费大模型** —— 把 OpenCode Zen 免费档模型装进 DeepSeek Harness，零配置、免注册、免充值，装完即用。

[English](README.md)

---

## 为什么用这个插件？

你正在看的这段对话，就是由它驱动的：**DeepSeek V4 Flash，免费额度，一分钱没花。**

- 💰 **真免费** —— 官方免费档用字面量 key `public` 认证，不需要注册、不需要充值、不需要 API Key
- 🧮 **6 个免费模型** —— DeepSeek V4 Flash、小米 MiMo、腾讯混元、NVIDIA Nemotron 双雄、Laguna S 2.1，随便挑
- ⚡ **即装即用** —— 装完重启 `dsh web`，模型选择器里直接多出 `opencode` 路由，无需任何配置
- 🔑 **额度叠加** —— 配合 dsh-api-key-pool 多 Key 轮换，多个免费账号额度自动叠加、自动切换
- 🛡️ **额度友好** —— 内置 429/5xx 退避重试与请求节流，不会一把打爆免费额度
- 🧠 **能力齐全** —— 流式输出、推理内容（reasoning）透传、工具调用，和付费模型体验一致

## 模型列表（6 个免费模型）

| 模型 | 上下文窗口 | 备注 |
|---|---|---|
| `deepseek-v4-flash-free` | 200k | DeepSeek V4 Flash · 推理 + 工具调用，日常主力 |
| `mimo-v2.5-free` | 200k | 小米 MiMo 2.5 |
| `hy3-free` | 200k | 腾讯混元 |
| `nemotron-3-ultra-free` | 131,072 | NVIDIA Nemotron 3 Ultra |
| `nemotron-3.5-lightning-free` | 131,072 | NVIDIA Nemotron 3.5 Lightning |
| `laguna-s-2.1-free` | 200k | Laguna S 2.1 |

推理强度：`off` / `low` / `high`（默认）/ `max`，想要多快或多深随你调。

## 安装

```sh
dsh plugin --profile web add github:xiaozhe7772222/dsh-opencode-zen
```

重启 `dsh web` → **设置 → 模型** → 选择提供器 `opencode` → 挑一个免费模型（推荐 `deepseek-v4-flash-free`），开聊。

## 配置（可选，默认零配置）

### 多账号额度叠加（推荐）

1. 安装 [dsh-api-key-pool](https://github.com/xiaozhe7772222/dsh-api-key-pool)
2. 在它的 pool 配置里为 `opencode` 添加你的多个 key
3. 插件自动读取并轮换使用，多账号免费额度叠加

### 环境变量

启动 `dsh web` 前设置 `OPENCODE_ZEN_API_KEY` 或 `OPENCODE_GO_API_KEY` 即可。

什么都不配也行——插件最终兜底到官方公开档 `public`。

## 常见问题

**Q: 模型返回 429 Too Many Requests 怎么办？**
A: 免费档有按 IP 的速率限制。等 30–60 秒再试，或者安装 [dsh-api-key-pool](https://github.com/xiaozhe7772222/dsh-api-key-pool) 自动轮换多个 Key。

**Q: 模型选择器里没有 `opencode` 提供器？**
A: 完全重启 `dsh web`（不是只刷新页面）。用 `dsh plugin --profile web list` 确认插件已安装。

**Q: 支持哪些 DSH 版本？**
A: DSH 0.8.0+（需要 `ctx.llm.registerAdapter` API）。旧版本可能需要手动注册路由。

**Q: 这些模型真的永久免费吗？**
A: 使用的是 OpenCode Zen 官方公开免费档。服务可用性和额度限制以 OpenCode Zen 官方政策为准——本插件只是一个客户端适配器。

## 原理

通过 `ctx.llm.registerAdapter(['opencode'], adapter)` 注册 LLM 提供器路由，把 OpenCode Zen 免费模型挂进 DSH 模型体系，会话模型、子代理都能用。

## 许可

MIT
