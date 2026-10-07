// Committed parity snapshot of the static MODELS table — extracted ONCE at
// test-authoring time (Plan 3 Task 2) from the installed-pin commit:
//
//   git show a416790:lib/index.js | sed -n '62,70p'   # the 9 MODELS entries
//
// Source commit: a416790a1487717bd4532ab9905788013e8fbaea
//   "fix: drive pinned-family requests through the owning undici; restore native settings typography"
//
// The suite requires THIS file instead of `git show` at runtime and never
// reads the installed copy under ~/.dsh (plan Review Focus #5). Entry
// vocabulary: id,name,contextWindow,maxOutput,description,vision?,efforts?,
// responses?,reasoningRequired? — NO defaultMaxTokens, NO reasoning.*: those
// are resolveModel() OUTPUT, never table fields.
module.exports = [
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
