// @ts-nocheck
// dsh-opencode-zen web client.
//
// The counters live in the host process (they are incremented where the fetch
// patch lives), so every surface here reads the plugin's own loopback status
// endpoint instead of keeping a second source of truth.
//
// Three seats, all fed by the same hook:
//   conversation.input.right  — compact family switch next to the send button
//   conversation.input.dock   — one-line quota status above the composer
//   settings.section          — the statistics page
//
// Written as a loader-compatible IIFE on purpose: no build step and no bundled
// React — everything comes from the host loader through `Ve('react')`.
;(function bootstrapZenClient() {
  const register = () => {
    if (typeof window === 'undefined' || !window.__ModuleLoader__) return
    window.__ModuleLoader__.load({
      id: 'dsh-opencode-zen',
      factory: (Ve) => {
        const React = Ve('react')
        const { createElement: h, useCallback, useEffect, useRef, useState } = React

        const DEFAULT_URL = 'http://127.0.0.1:47821'
        const URL_KEY = 'dsh-opencode-zen.statusUrl'
        const REFRESH_MS = 30000
        const FAMILIES = ['auto', 'ipv4', 'ipv6']
        const FAMILY_LABEL = { auto: 'auto', ipv4: 'ipv4', ipv6: 'ipv6' }

        const STYLE = '.zen-btn{border:1px solid var(--dsw-alias-border-weak,rgba(127,127,127,.35));background:transparent;color:inherit;border-radius:6px;padding:3px 8px;cursor:pointer;font:inherit;font-size:12px;line-height:18px;white-space:nowrap}' +
          '.zen-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}' +
          '.zen-btn:disabled{opacity:.55;cursor:default}' +
          '.zen-dock{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:2px 4px;font-size:12px;opacity:.85}' +
          '.zen-chip{display:inline-flex;align-items:center;gap:4px}' +
          '.zen-ok{color:var(--dsw-alias-status-success,var(--dsw-alias-label-tertiary))}' +
          '.zen-dead{color:var(--dsw-alias-status-error,#e5484d);font-weight:600}' +
          '.zen-panel{display:flex;flex-direction:column;gap:12px}' +
          '.zen-table{width:100%;border-collapse:collapse;font-size:13px}' +
          '.zen-table th,.zen-table td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-weak,rgba(127,127,127,.25))}' +
          '.zen-num{font-variant-numeric:tabular-nums}' +
          '.zen-note{opacity:.75;font-size:12px;line-height:1.45}' +
          '.zen-current{font-weight:600}'

        function formatDuration(ms) {
          if (!Number.isFinite(ms) || ms <= 0) return '0 мин'
          const total = Math.ceil(ms / 60000)
          const hours = Math.floor(total / 60)
          const minutes = total % 60
          if (hours > 0) return `${hours} ч ${minutes} мин`
          return `${minutes} мин`
        }

        function formatClock(ms) {
          return `${new Date(ms).toISOString().slice(11, 16)} UTC`
        }

        /** Per-family verdict: is the daily bucket spent, or is it still free? */
        function familyStatus(bucket) {
          if (bucket === undefined || bucket.daily429 === 0) return { tone: 'ok', text: 'свободна' }
          if (bucket.baselineUnknown) return { tone: 'dead', text: 'исчерпана (граница неизвестна)' }
          return { tone: 'dead', text: `исчерпана при ≥ ${bucket.first429.ok}` }
        }

        /** Shared data hook: the loopback snapshot plus the family switch. */
        function useZenStatus() {
          const [baseUrl, setBaseUrl] = useState(() => {
            try { return window.localStorage.getItem(URL_KEY) || DEFAULT_URL } catch { return DEFAULT_URL }
          })
          const [snapshot, setSnapshot] = useState(null)
          const [error, setError] = useState(null)
          const [pending, setPending] = useState(false)
          const baseRef = useRef(baseUrl)
          baseRef.current = baseUrl

          const call = useCallback(async (route, body) => {
            const response = await fetch(`${baseRef.current}${route}`, body === undefined
              ? undefined
              : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
            const payload = await response.json()
            if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`)
            return payload
          }, [])

          const refresh = useCallback(async () => {
            try {
              setSnapshot(await call('/zen/quota'))
              setError(null)
            } catch (failure) {
              setError(String(failure?.message ?? failure))
            }
          }, [call])

          useEffect(() => { refresh() }, [refresh])
          useEffect(() => {
            const timer = setInterval(refresh, REFRESH_MS)
            return () => clearInterval(timer)
          }, [refresh])

          const setFamily = useCallback(async (family) => {
            if (!FAMILIES.includes(family)) return
            setPending(true)
            try {
              setSnapshot(await call('/zen/family', { family }))
            } catch (failure) {
              setError(String(failure?.message ?? failure))
            } finally {
              setPending(false)
            }
          }, [call])

          return { baseUrl, setBaseUrl, snapshot, error, pending, refresh, setFamily }
        }

        /**
         * Composer switch: one tap cycles auto → ipv4 → ipv6 → auto, so the
         * recovery path when a bucket runs dry stays a single click. The button
         * turns red while the CURRENT family is the exhausted one.
         */
        function ZenFamilyToggle() {
          const { snapshot, error, pending, setFamily } = useZenStatus()
          const current = snapshot?.family ?? 'auto'
          const cycle = useCallback(() => {
            const next = FAMILIES[(FAMILIES.indexOf(current) + 1) % FAMILIES.length]
            setFamily(next)
          }, [current, setFamily])

          const dead = familyStatus(snapshot?.buckets?.[current]).tone === 'dead'
          const title = error !== null
            ? `OpenCode Zen: статус недоступен (${error})`
            : `OpenCode Zen: запросы идут через ${FAMILY_LABEL[current]} — клик переключает`

          return h('button', {
            className: `zen-btn ${dead ? 'zen-dead' : 'zen-ok'}`,
            type: 'button',
            title,
            disabled: pending || snapshot?.familyLocked === true,
            onClick: cycle,
          }, `Zen · ${FAMILY_LABEL[current]}`)
        }

        /** One line above the composer: what each bucket looks like right now. */
        function ZenStatusDock() {
          const { snapshot, error } = useZenStatus()
          const [, setTick] = useState(0)

          // The countdown is the only thing that has to move on its own.
          useEffect(() => {
            const timer = setInterval(() => setTick((value) => value + 1), 30000)
            return () => clearInterval(timer)
          }, [])

          if (error !== null || snapshot === null) return null

          const chips = FAMILIES.map((family) => {
            const bucket = snapshot.buckets[family]
            const status = familyStatus(bucket)
            const marker = snapshot.family === family ? '● ' : ''
            return h('span', { key: family, className: `zen-chip zen-${status.tone}` },
              `${marker}${FAMILY_LABEL[family]}: ${status.text}`,
              h('span', { className: 'zen-num' }, ` (${bucket.ok})`),
            )
          })

          return h('div', { className: 'zen-dock' },
            h('span', null, 'Zen:'),
            chips,
            h('span', { className: 'zen-num' }, `обновление через ${formatDuration(snapshot.resetAt - Date.now())}`),
            h('span', { className: 'zen-num' }, `(${formatClock(snapshot.resetAt)})`),
          )
        }

        /** Settings page: the numbers, nothing else. */
        function ZenPanel() {
          const { baseUrl, setBaseUrl, snapshot, error, refresh } = useZenStatus()
          const [draftUrl, setDraftUrl] = useState(baseUrl)

          const rows = snapshot === null
            ? []
            : FAMILIES.map((family) => {
              const bucket = snapshot.buckets[family]
              const status = familyStatus(bucket)
              const bound = bucket.daily429 === 0
                ? '—'
                : bucket.baselineUnknown ? 'неизвестно' : `≥ ${bucket.first429.ok}`
              return h('tr', { key: family },
                h('td', { className: snapshot.family === family ? 'zen-current' : null },
                  `${FAMILY_LABEL[family]}${snapshot.family === family ? ' · сейчас' : ''}`),
                h('td', { className: 'zen-num' }, String(bucket.ok)),
                h('td', null, bound),
                h('td', { className: status.tone === 'dead' ? 'zen-dead' : 'zen-ok' }, status.text),
              )
            })

          return h('div', { className: 'zen-panel' },
            h('style', null, STYLE),
            error !== null && h('div', { className: 'zen-dead' }, `Статус-эндпоинт недоступен: ${error}`),
            snapshot !== null && h('div', null,
              h('div', { className: 'zen-num' },
                `Квота обновится через ${formatDuration(snapshot.resetAt - Date.now())} (${formatClock(snapshot.resetAt)})`),
              h('table', { className: 'zen-table' },
                h('thead', null, h('tr', null,
                  h('th', null, 'Семейство'),
                  h('th', null, 'Ответов 2xx сегодня'),
                  h('th', null, 'Порог'),
                  h('th', null, 'Rate limit'),
                )),
                h('tbody', null, rows),
              ),
              h('button', { className: 'zen-btn', onClick: refresh }, 'Обновить'),
            ),
            h('div', { className: 'zen-note' },
              'Корзины ключуются по сырой строке egress IP: ipv4 и ipv6 считаются отдельно, все адреса внутри одного ipv6 /64 живут в одной корзине.'),
            h('div', { className: 'zen-note' },
              'Переключение семейства — прямо в чате: кнопка «Zen · …» рядом с отправкой, клик циклит auto → ipv4 → ipv6.'),
            h('div', { className: 'zen-note' },
              'Гейтвей не отдаёт заголовки rate-limit, поэтому «порог» — нижняя граница, которую плагин увидел сам, а не точное значение лимита.'),
            h('div', null,
              h('input', {
                className: 'zen-btn',
                style: { minWidth: '260px' },
                value: draftUrl,
                onChange: (event) => setDraftUrl(event.target.value),
              }),
              h('button', {
                className: 'zen-btn',
                onClick: () => {
                  try { window.localStorage.setItem(URL_KEY, draftUrl) } catch { /* private mode */ }
                  setBaseUrl(draftUrl)
                },
              }, 'Подключить'),
            ),
          )
        }

        function apply(ctx) {
          // `slots` is the service these surfaces live in. Declaring it is not
          // optional: the fiber only resolves services named in the plugin's
          // `inject` export, so an empty list hands us a ctx without ctx.slots.
          //
          // The UI is a convenience, never a dependency: if a seat ever moves,
          // log it and let the rest of the web UI boot.
          const guard = (seat, descriptor, component) => {
            try {
              ctx.slots.inject(seat, () => ctx.slots.register(descriptor, component))
            } catch (error) {
              console.warn(`[dsh-opencode-zen] slot ${seat} unavailable:`, error)
            }
          }

          guard('settings.section', {
            name: 'settings.section',
            id: 'dsh-opencode-zen',
            order: 50,
            label: () => 'OpenCode Zen',
          }, ZenPanel)

          guard('conversation.input.right', {
            name: 'conversation.input.right',
            id: 'dsh-opencode-zen.family',
            order: 20,
            label: () => 'OpenCode Zen',
          }, ZenFamilyToggle)

          guard('conversation.input.dock', {
            name: 'conversation.input.dock',
            id: 'dsh-opencode-zen.status',
            order: 50,
            label: () => 'OpenCode Zen',
          }, ZenStatusDock)
        }

        const exports = {}
        exports.apply = apply
        exports.inject = ['slots']
        return exports
      },
    })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', register)
  } else {
    register()
  }
})()
