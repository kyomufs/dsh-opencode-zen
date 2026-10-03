// @ts-nocheck
// dsh-opencode-zen web client.
//
// The counters live in the host process (they are incremented where the fetch
// patch lives), so every surface here reads the plugin's own loopback status
// endpoint instead of keeping a second source of truth.
//
// Two seats, fed by the same hook:
//   conversation.input.right  — "Zen · <family>" menu in the composer tool row,
//                                next to model/effort, built from the shipped
//                                Menu primitive so it looks native
//   settings.section          — the statistics page
//
// Written as a loader-compatible IIFE on purpose: no build step and no bundled
// React — everything comes from the host loader through `require`.
;(function bootstrapZenClient() {
  const register = () => {
    if (typeof window === 'undefined' || !window.__ModuleLoader__) return
    window.__ModuleLoader__.load({
      id: 'dsh-opencode-zen',
      factory: (require) => {
        const React = require('react')
        const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
        const { createElement: h, useCallback, useEffect, useRef, useState } = React
        const { Menu, IconGlobeOutlineRegular, IconChevronDownOutlineRegular, IconClockOutlineRegular } = primitives

        const DEFAULT_URL = 'http://127.0.0.1:47821'
        const URL_KEY = 'dsh-opencode-zen.statusUrl'
        const REFRESH_MS = 30000
        const FAMILIES = ['auto', 'ipv4', 'ipv6']
        const HINT = {
          auto: 'DSH выбирает семейство сам',
          ipv4: 'запросы уходят по IPv4',
          ipv6: 'запросы уходят по IPv6',
        }

        // Design tokens only — the same alias palette the shipped UI uses, so
        // both seats follow light/dark without inventing colors.
        const STYLE = '.zen-trigger{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 8px;border:1px solid transparent;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-family);font-size:var(--dsw-font-xs-13);line-height:20px;cursor:pointer;white-space:nowrap}' +
          '.zen-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}' +
          '.zen-trigger:disabled{opacity:.55;cursor:default}' +
          '.zen-trigger:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:1px}' +
          '.zen-triggerValue{color:var(--dsw-alias-label-primary);font-weight:500}' +
          '.zen-triggerDead .zen-triggerValue,.zen-triggerDead .zen-triggerIcon{color:var(--dsw-alias-state-error-primary)}' +
          '.zen-item{display:flex;flex-direction:column;gap:1px;min-width:160px}' +
          '.zen-itemHint{font-size:var(--dsw-font-xxxs-11);line-height:15px;color:var(--dsw-alias-label-tertiary)}' +
          '.zen-panel{display:flex;flex-direction:column;gap:16px;font-family:var(--dsw-font-family);font-size:var(--dsw-font-s-14);line-height:20px;color:var(--dsw-alias-label-primary)}' +
          '.zen-headline{display:flex;align-items:center;gap:8px;font-size:var(--dsw-font-m-18);font-weight:500}' +
          '.zen-card{display:flex;flex-direction:column;gap:10px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1)}' +
          '.zen-reset{display:flex;align-items:center;gap:8px;font-size:var(--dsw-font-s-strong-14)}' +
          '.zen-num{font-family:var(--dsw-font-mono);font-variant-numeric:tabular-nums}' +
          '.zen-mutes{color:var(--dsw-alias-label-tertiary);font-size:var(--dsw-font-xxs-12)}' +
          '.zen-table{width:100%;border-collapse:collapse}' +
          '.zen-table th{text-align:left;padding:6px 8px;font-size:var(--dsw-font-xxxs-11);font-weight:500;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);border-bottom:1px solid var(--dsw-alias-border-l2)}' +
          '.zen-table td{padding:8px;font-size:var(--dsw-font-xs-13);border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:top}' +
          '.zen-current{font-weight:600}' +
          '.zen-ok{color:var(--dsw-alias-state-success-primary)}' +
          '.zen-dead{color:var(--dsw-alias-state-error-primary)}' +
          '.zen-note{font-size:var(--dsw-font-xxs-12);line-height:17px;color:var(--dsw-alias-label-tertiary)}' +
          '.zen-field{display:flex;align-items:center;gap:8px}' +
          '.zen-input{flex:1;min-width:0;height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-mono);font-size:var(--dsw-font-xxs-12)}' +
          '.zen-button{height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:var(--dsw-font-xs-13);cursor:pointer}' +
          '.zen-button:hover{background:var(--dsw-alias-interactive-bg-hover)}'

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
         * Composer tool-row menu, sibling of model/effort: the shipped `Menu`
         * primitive draws the surface, the checkmark and the keyboard handling,
         * so this stays visually native instead of hand-rolled chrome.
         */
        function ZenFamilyMenu() {
          const { snapshot, error, pending, setFamily } = useZenStatus()
          const current = snapshot?.family ?? 'auto'
          const [open, setOpen] = useState(false)

          const dead = familyStatus(snapshot?.buckets?.[current]).tone === 'dead'
          const locked = pending || snapshot?.familyLocked === true
          const title = error !== null
            ? `OpenCode Zen: статус недоступен (${error})`
            : 'OpenCode Zen: семейство egress для запросов к лимиту'

          const items = FAMILIES.map((family) => ({
            id: family,
            disabled: locked,
            label: h('span', { className: 'zen-item' },
              h('span', null, family),
              h('span', { className: 'zen-itemHint' }, HINT[family]),
            ),
          }))

          return h(Menu, {
            open,
            anchor: h('button', {
              type: 'button',
              className: `zen-trigger${dead ? ' zen-triggerDead' : ''}`,
              'aria-haspopup': 'menu',
              'aria-expanded': open,
              title,
              disabled: locked,
              onClick: () => setOpen((value) => !value),
            },
            h(IconGlobeOutlineRegular, { size: 16, className: 'zen-triggerIcon' }),
            h('span', null, 'Zen'),
            h('span', { className: 'zen-triggerValue' }, current),
            h(IconChevronDownOutlineRegular, { size: 12, className: 'zen-triggerIcon' })),
            items,
            selectedId: current,
            align: 'start',
            side: 'top',
            portal: true,
            selection: 'check',
            onSelect: (family) => {
              setOpen(false)
              setFamily(family)
            },
            onClose: () => setOpen(false),
          })
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
                h('td', { className: snapshot.family === family ? 'zen-current' : null }, family),
                h('td', { className: 'zen-num' }, String(bucket.ok)),
                h('td', null, bound),
                h('td', { className: status.tone === 'dead' ? 'zen-dead' : 'zen-ok' }, status.text),
              )
            })

          return h('div', { className: 'zen-panel' },
            h('style', null, STYLE),
            h('div', { className: 'zen-headline' },
              h(IconGlobeOutlineRegular, { size: 18 }),
              'OpenCode Zen',
            ),
            error !== null && h('div', { className: 'zen-card' },
              h('div', { className: 'zen-dead' }, 'Статус-эндпоинт недоступен'),
              h('div', { className: 'zen-mutes' }, error),
            ),
            snapshot !== null && h('div', { className: 'zen-card' },
              h('div', { className: 'zen-reset' },
                h(IconClockOutlineRegular, { size: 16 }),
                'Квота обновится через ',
                h('span', { className: 'zen-num' }, formatDuration(snapshot.resetAt - Date.now())),
              ),
              h('div', { className: 'zen-mutes' },
                `следующий сброс — ${formatClock(snapshot.resetAt)}; текущее семейство: ${snapshot.family}`),
              h('table', { className: 'zen-table' },
                h('thead', null, h('tr', null,
                  h('th', null, 'Семейство'),
                  h('th', null, 'Ответов 2xx'),
                  h('th', null, 'Порог'),
                  h('th', null, 'Rate limit'),
                )),
                h('tbody', null, rows),
              ),
              h('button', { className: 'zen-button', onClick: refresh }, 'Обновить'),
            ),
            h('div', { className: 'zen-note' },
              'Корзины ключуются по сырой строке egress IP: ipv4 и ipv6 считаются отдельно, все адреса внутри одного ipv6 /64 живут в одной корзине.'),
            h('div', { className: 'zen-note' },
              'Гейтвей не отдаёт заголовки rate-limit, поэтому «порог» — нижняя граница, которую плагин увидел сам, а не точное значение лимита.'),
            h('div', { className: 'zen-field' },
              h('input', {
                className: 'zen-input',
                value: draftUrl,
                spellCheck: false,
                onChange: (event) => setDraftUrl(event.target.value),
              }),
              h('button', {
                className: 'zen-button',
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

          guard('conversation.input.right', {
            name: 'conversation.input.right',
            id: 'dsh-opencode-zen.family',
            order: 20,
            label: () => 'OpenCode Zen',
          }, ZenFamilyMenu)

          guard('settings.section', {
            name: 'settings.section',
            id: 'dsh-opencode-zen',
            order: 50,
            label: () => 'OpenCode Zen',
          }, ZenPanel)
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
