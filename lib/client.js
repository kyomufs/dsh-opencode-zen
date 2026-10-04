// @ts-nocheck
// dsh-opencode-zen web client.
//
// The counters live in the host process (they are incremented where the fetch
// patch lives), so the web entry reads the plugin's own loopback status
// endpoint instead of keeping a second source of truth. The client ships as a
// loader-compatible IIFE so it stays installable without a build step, and it
// resolves React and the UI primitives through the host loader instead of
// bundling either one.
//
// One seat only:
//   settings.section — family switcher (auto / ipv4 / ipv6) + quota table
//
// Everything else is available through the loopback endpoints themselves
// (curl the status server); the UI deliberately shows only the controls a
// person actually touches.
;(function bootstrapZenClient() {
  const register = () => {
    if (typeof window === 'undefined' || !window.__ModuleLoader__) return
    window.__ModuleLoader__.load({
      id: 'dsh-opencode-zen',
      factory: (require) => {
        const React = require('react')
        const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
        const { createElement: h, useCallback, useEffect, useRef, useState } = React
        const { IconGlobeOutlineRegular, IconClockOutlineRegular } = primitives

        // The status server is plugin-owned and loopback-only; no URL setting
        // in the UI — a different port is an operator concern (config), not a
        // per-user one.
        const STATUS_URL = 'http://127.0.0.1:47821'
        const REFRESH_MS = 30000
        const FAMILIES = ['auto', 'ipv4', 'ipv6']
        const HINT = {
          auto: 'DSH выбирает семейство сам',
          ipv4: 'запросы уходят по IPv4',
          ipv6: 'запросы уходят по IPv6',
        }

        // Design tokens only — the host theme may change; hand-picked hex
        // values go stale the first time someone switches to dark mode.
        const STYLE = [
          '.zen-panel{',
          'display:flex;flex-direction:column;gap:16px;max-width:420px;',
          'font-family:var(--dsw-font-family);',
          'font-size:var(--dsw-font-s-14);line-height:20px;',
          'color:var(--dsw-alias-label-primary);',
          '}',
          '.zen-headline{',
          'display:flex;align-items:center;gap:8px;',
          'font-size:var(--dsw-font-m-18);font-weight:600;letter-spacing:-0.01em;',
          '}',
          '.zen-card{',
          'display:flex;flex-direction:column;gap:12px;',
          'padding:14px 16px;',
          'border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);',
          'background:var(--dsw-alias-bg-layer-1);',
          '}',
          '.zen-cardError{border-color:var(--dsw-alias-state-error-primary)}',
          '.zen-errorText{',
          'font-size:var(--dsw-font-s-14);font-weight:500;',
          'color:var(--dsw-alias-state-error-primary);',
          '}',
          '.zen-errorHint{',
          'font-size:var(--dsw-font-xxs-12);line-height:17px;',
          'color:var(--dsw-alias-label-tertiary);',
          '}',
          '.zen-seg{',
          'display:inline-flex;gap:2px;align-self:flex-start;',
          'padding:2px;',
          'border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);',
          'background:var(--dsw-alias-bg-base);',
          '}',
          '.zen-segBtn{',
          'height:26px;padding:0 12px;',
          'border:none;border-radius:calc(var(--dsw-radius-sm) - 1px);',
          'background:transparent;',
          'color:var(--dsw-alias-label-secondary);',
          'font-family:var(--dsw-font-family);font-size:var(--dsw-font-xs-13);font-weight:500;',
          'cursor:pointer;',
          'transition:background .12s ease,color .12s ease;',
          '}',
          '.zen-segBtn:hover:not(:disabled){',
          'background:var(--dsw-alias-interactive-bg-hover);',
          'color:var(--dsw-alias-label-primary);',
          '}',
          '.zen-segBtn:disabled{opacity:.55;cursor:default}',
          '.zen-segBtn:focus-visible{',
          'outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);',
          'outline-offset:1px;',
          '}',
          '.zen-segBtnOn{',
          'background:var(--dsw-alias-bg-layer-1);',
          'box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2);',
          'color:var(--dsw-alias-label-primary);font-weight:600;',
          '}',
          '.zen-hint{',
          'font-size:var(--dsw-font-xxs-12);line-height:17px;',
          'color:var(--dsw-alias-label-tertiary);',
          '}',
          '.zen-reset{',
          'display:flex;align-items:center;gap:8px;',
          'font-size:var(--dsw-font-s-strong-14);',
          '}',
          '.zen-resetMutes{',
          'font-size:var(--dsw-font-xxs-12);',
          'color:var(--dsw-alias-label-tertiary);',
          '}',
          '.zen-num{',
          'font-family:var(--dsw-font-mono);font-variant-numeric:tabular-nums;',
          '}',
          '.zen-table{width:100%;border-collapse:collapse}',
          '.zen-table th{',
          'padding:0 12px 8px 0;',
          'text-align:left;',
          'font-size:var(--dsw-font-xxxs-11);font-weight:600;letter-spacing:.06em;text-transform:uppercase;',
          'color:var(--dsw-alias-label-tertiary);',
          'border-bottom:1px solid var(--dsw-alias-border-l2);',
          '}',
          '.zen-table th:last-child,.zen-table td:last-child{padding-right:0}',
          '.zen-table td{',
          'padding:10px 12px 10px 0;',
          'font-size:var(--dsw-font-xs-13);line-height:18px;',
          'border-bottom:1px solid var(--dsw-alias-border-l1);',
          'vertical-align:middle;',
          '}',
          '.zen-table tbody tr:last-child td{border-bottom:none}',
          '.zen-table tbody tr:hover td{background:var(--dsw-alias-interactive-bg-hover)}',
          '.zen-typeCell{',
          'display:flex;align-items:center;gap:8px;',
          'font-family:var(--dsw-font-mono);font-weight:500;',
          '}',
          '.zen-dot{',
          'width:6px;height:6px;border-radius:50%;flex:none;',
          'background:var(--dsw-alias-label-tertiary);',
          '}',
          '.zen-dotOk{background:var(--dsw-alias-state-success-primary)}',
          '.zen-dotDead{background:var(--dsw-alias-state-error-primary)}',
          '.zen-rowCurrent td{background:var(--dsw-alias-interactive-bg-hover)}',
          '.zen-ok{',
          'color:var(--dsw-alias-state-success-primary);font-weight:500;',
          '}',
          '.zen-dead{',
          'color:var(--dsw-alias-state-error-primary);font-weight:500;',
          '}',
          '.zen-button{',
          'height:28px;padding:0 12px;align-self:flex-start;',
          'border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);',
          'background:var(--dsw-alias-bg-layer-1);',
          'color:var(--dsw-alias-label-primary);',
          'font-family:var(--dsw-font-family);font-size:var(--dsw-font-xs-13);font-weight:500;',
          'cursor:pointer;',
          'transition:background .12s ease;',
          '}',
          '.zen-button:hover{background:var(--dsw-alias-interactive-bg-hover)}',
          '.zen-button:focus-visible{',
          'outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);',
          'outline-offset:1px;',
          '}',
          '.zen-note{',
          'font-size:var(--dsw-font-xxs-12);line-height:17px;',
          'color:var(--dsw-alias-label-tertiary);',
          '}',
        ].join('')

        let styleInjected = false
        const injectStyle = () => {
          if (styleInjected) return
          styleInjected = true
          if (typeof document === 'undefined' || !document.head) return
          const style = document.createElement('style')
          style.setAttribute('data-dsh-opencode-zen', 'client')
          style.textContent = STYLE
          document.head.appendChild(style)
        }
        // Only defer while the document is still being parsed — plugin modules
        // usually execute after DOMContentLoaded, where that event never fires
        // again.
        if (typeof document !== 'undefined') {
          if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', injectStyle, { once: true })
          } else {
            injectStyle()
          }
        }

        function formatDuration(ms) {
          if (!Number.isFinite(ms) || ms <= 0) return '—'
          const totalMinutes = Math.ceil(ms / 60000)
          const hours = Math.floor(totalMinutes / 60)
          const minutes = totalMinutes % 60
          if (hours > 0) return `${hours} ч ${minutes} мин`
          return `${minutes} мин`
        }

        function formatClock(ms) {
          if (!Number.isFinite(ms) || ms <= 0) return '—'
          return new Date(ms).toISOString().slice(11, 16)
        }

        function familyStatus(bucket) {
          if (bucket === undefined) return { tone: 'idle', text: '—' }
          if (bucket.daily429 === 0) return { tone: 'ok', text: 'свободна' }
          if (bucket.baselineUnknown) {
            return { tone: 'dead', text: 'исчерпана (граница неизвестна)' }
          }
          return { tone: 'dead', text: `исчерпана при ≥ ${bucket.first429.ok}` }
        }

        // The quota numbers come from the host-owned loopback endpoint, so the
        // web entry keeps a single source of truth. The family switch posts
        // back to the same endpoint instead of mutating plugin state in the
        // page, which would drift from what the host actually uses.
        function useZenStatus() {
          const [snapshot, setSnapshot] = useState(null)
          const [error, setError] = useState(null)
          const [pending, setPending] = useState(false)

          const call = useCallback(async (route, body) => {
            const response = await fetch(`${STATUS_URL}${route}`, body === undefined
              ? undefined
              : {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
              })
            const payload = await response.json().catch(() => null)
            if (!response.ok) {
              throw new Error(payload?.error || `HTTP ${response.status}`)
            }
            return payload
          }, [])

          const refresh = useCallback(async () => {
            try {
              setSnapshot(await call('/zen/quota'))
              setError(null)
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err))
            }
          }, [call])

          const setFamily = useCallback(async (family) => {
            setPending(true)
            try {
              setSnapshot(await call('/zen/family', { family }))
              setError(null)
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err))
            } finally {
              setPending(false)
            }
          }, [call])

          const timer = useRef(null)
          useEffect(() => {
            refresh()
            timer.current = setInterval(refresh, REFRESH_MS)
            return () => {
              if (timer.current !== null) clearInterval(timer.current)
            }
          }, [refresh])

          return { snapshot, error, pending, refresh, setFamily }
        }

        function ZenPanel() {
          const { snapshot, error, pending, refresh, setFamily } = useZenStatus()
          const current = snapshot?.family ?? 'auto'
          const locked = pending || snapshot?.familyLocked === true

          const rows = FAMILIES.map((family) => {
            const bucket = snapshot?.buckets?.[family]
            const status = familyStatus(bucket)
            const isCurrent = family === current
            const dotTone = status.tone === 'dead' ? 'zen-dotDead' : status.tone === 'ok' ? 'zen-dotOk' : ''
            return h('tr', {
              key: family,
              className: isCurrent ? 'zen-rowCurrent' : undefined,
            },
            h('td', null,
              h('span', { className: 'zen-typeCell' },
                h('span', { className: `zen-dot ${dotTone}` }),
                family)),
            h('td', { className: status.tone === 'dead' ? 'zen-dead' : status.tone === 'ok' ? 'zen-ok' : undefined },
              status.text),
            )
          })

          return h('div', { className: 'zen-panel' },
            h('div', { className: 'zen-headline' },
              h(IconGlobeOutlineRegular, { size: 18 }),
              'OpenCode Zen'),
            error !== null && h('div', { className: 'zen-card zen-cardError' },
              h('div', { className: 'zen-errorText' }, 'Статус-эндпоинт недоступен'),
              h('div', { className: 'zen-errorHint' }, error)),
            h('div', { className: 'zen-card' },
              h('div', { className: 'zen-seg' }, FAMILIES.map((family) =>
                h('button', {
                  key: family,
                  type: 'button',
                  className: `zen-segBtn${family === current ? ' zen-segBtnOn' : ''}`,
                  disabled: locked,
                  title: HINT[family],
                  onClick: () => setFamily(family),
                }, family))),
              h('div', { className: 'zen-hint' },
                HINT[current] + (snapshot?.familyLocked === true ? ' · зафиксировано конфигом' : '')),
              snapshot !== null && h('div', { className: 'zen-reset' },
                h(IconClockOutlineRegular, { size: 16 }),
                'Квота обновится через ',
                h('span', { className: 'zen-num' }, formatDuration(snapshot.resetAt - Date.now())),
                h('span', { className: 'zen-resetMutes' }, ` · сброс ${formatClock(snapshot.resetAt)} UTC`)),
              h('table', { className: 'zen-table' },
                h('thead', null, h('tr', null,
                  h('th', null, 'type'),
                  h('th', null, 'rate limit'))),
                h('tbody', null, rows)),
              h('button', { className: 'zen-button', onClick: refresh }, 'Обновить')),
            h('div', { className: 'zen-note' },
              'Корзины ключуются по сырой строке egress IP: ipv4 и ipv6 считаются отдельно, все адреса внутри одного ipv6 /64 живут в одной корзине.'),
            h('div', { className: 'zen-note' },
              'Гейтвей не отдаёт заголовки rate-limit, поэтому статус — нижняя граница, которую плагин увидел сам.'),
          )
        }

        function apply(ctx) {
          // A broken settings shell must not take the whole web entry down, so
          // every seat reports instead of throwing.
          const guard = (seat, descriptor, component) => {
            try {
              if (!ctx?.slots?.inject) throw new Error('slots service unavailable')
              ctx.slots.inject(seat, () => {
                if (!ctx?.slots?.register) throw new Error('slots service unavailable')
                ctx.slots.register(descriptor, component)
              })
            } catch (error) {
              // eslint-disable-next-line no-console
              console.warn(`[dsh-opencode-zen] slot ${seat} unavailable:`, error)
            }
          }

          // The whole surface lives in Settings: the family switch moved out of
          // the composer in 0.15.0, and diagnostics stayed on the loopback
          // endpoints instead of becoming UI.
          guard('settings.section', {
            name: 'settings.section',
            id: 'dsh-opencode-zen',
            order: 50,
            label: () => 'OpenCode Zen',
          }, ZenPanel)
        }

        return { apply, inject: ['slots'] }
      },
    })
  }

  if (typeof document === 'undefined') return
  // Only defer while the document is still being parsed: plugin modules are
  // usually executed after DOMContentLoaded, where that event never fires again
  // and registration would silently never happen.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', register, { once: true })
  } else {
    register()
  }
})()
