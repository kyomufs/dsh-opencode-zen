// @ts-nocheck
// dsh-opencode-zen web client — the OpenCode Zen settings section.
//
// The plugin's counters live in the host process (they are incremented where
// the fetch patch lives), so the panel talks to the plugin's own loopback
// status endpoint instead of inventing a second source of truth. The endpoint
// is read-only apart from the two deliberate actions the panel offers: switch
// the pinned address family, and send one live probe.
//
// Written as a loader-compatible IIFE on purpose: no build step, no bundled
// React — everything comes from the host loader through `Ve('react')`.
;(function bootstrapZenSettings() {
  const register = () => {
    if (typeof window === 'undefined' || !window.__ModuleLoader__) return
    window.__ModuleLoader__.load({
      id: 'dsh-opencode-zen',
      factory: (Ve) => {
        const React = Ve('react')
        const { createElement: h, useCallback, useEffect, useRef, useState } = React

        const DEFAULT_URL = 'http://127.0.0.1:47821'
        const URL_KEY = 'dsh-opencode-zen.statusUrl'
        const STYLE = '.zen-panel{font:inherit;color:inherit;display:flex;flex-direction:column;gap:12px}' +
          '.zen-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}' +
          '.zen-table{width:100%;border-collapse:collapse;font-size:13px}' +
          '.zen-table th,.zen-table td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-weak,rgba(127,127,127,.25))}' +
          '.zen-num{font-variant-numeric:tabular-nums}' +
          '.zen-ok{color:var(--dsw-alias-status-success,var(--dsw-alias-label-tertiary))}' +
          '.zen-dead{color:var(--dsw-alias-status-error,#e5484d);font-weight:600}' +
          '.zen-note{opacity:.75;font-size:12px;line-height:1.45}' +
          '.zen-btn{border:1px solid var(--dsw-alias-border-weak,rgba(127,127,127,.35));background:transparent;color:inherit;border-radius:6px;padding:4px 10px;cursor:pointer;font:inherit}' +
          '.zen-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}' +
          '.zen-btn:disabled{opacity:.5;cursor:default}' +
          '.zen-select{background:transparent;color:inherit;border:1px solid var(--dsw-alias-border-weak,rgba(127,127,127,.35));border-radius:6px;padding:3px 6px;font:inherit}' +
          '.zen-verdict{font-size:12px;line-height:1.45}'

        function formatDuration(ms) {
          if (!Number.isFinite(ms) || ms <= 0) return '0 мин'
          const total = Math.ceil(ms / 60000)
          const hours = Math.floor(total / 60)
          const minutes = total % 60
          if (hours > 0) return `${hours} ч ${minutes} мин`
          return `${minutes} мин`
        }

        function formatClock(ms) {
          return new Date(ms).toISOString().slice(11, 16) + ' UTC'
        }

        /**
         * The gateway publishes no limit headers, so the panel never claims an
         * exact budget: it shows what this process observed and labels the rest
         * as unknown.
         */
        function describeBucket(bucket, family) {
          const used = h('td', { className: 'zen-num' }, String(bucket.ok))
          if (bucket.daily429 === 0) {
            return h('tr', null,
              h('td', null, family),
              used,
              h('td', { className: 'zen-note' }, '—'),
              h('td', null, h('span', { className: 'zen-ok' }, 'работает')),
            )
          }
          const bound = bucket.baselineUnknown
            ? 'неизвестно'
            : `≥ ${bucket.first429.ok}`
          const when = bucket.first429 !== null
            ? `первый 429 в ${formatClock(bucket.first429.at)}`
            : 'дневной лимит'
          return h('tr', null,
            h('td', null, family),
            used,
            h('td', null, h('span', { title: when }, bound)),
            h('td', null, h('span', { className: 'zen-dead' }, 'исчерпан')),
          )
        }

        function ZenPanel() {
          const [baseUrl, setBaseUrl] = useState(() => {
            try { return window.localStorage.getItem(URL_KEY) || DEFAULT_URL } catch { return DEFAULT_URL }
          })
          const [draftUrl, setDraftUrl] = useState(baseUrl)
          const [snapshot, setSnapshot] = useState(null)
          const [error, setError] = useState(null)
          const [busy, setBusy] = useState(null)
          const [probe, setProbe] = useState(null)
          const [spoof, setSpoof] = useState(null)
          const [now, setNow] = useState(() => Date.now())
          const baseRef = useRef(baseUrl)
          baseRef.current = baseUrl

          const call = useCallback(async (route, init) => {
            const response = await fetch(`${baseRef.current}${route}`, {
              ...init,
              headers: { 'content-type': 'application/json' },
            })
            const payload = await response.json()
            if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`)
            return payload
          }, [])

          const refresh = useCallback(async () => {
            try {
              const state = await call('/zen/quota')
              setSnapshot(state)
              setError(null)
            } catch (failure) {
              setError(String(failure?.message ?? failure))
            }
          }, [call])

          useEffect(() => { refresh() }, [refresh])

          // The reset countdown has to tick even when nothing else happens.
          useEffect(() => {
            const timer = setInterval(() => setNow(Date.now()), 1000)
            return () => clearInterval(timer)
          }, [])

          const runProbe = useCallback(async (family) => {
            setBusy(`probe-${family}`)
            setProbe(null)
            try {
              const result = await call('/zen/probe', {
                method: 'POST',
                body: JSON.stringify({ family }),
              })
              setProbe(result)
            } catch (failure) {
              setError(String(failure?.message ?? failure))
            } finally {
              setBusy(null)
              await refresh()
            }
          }, [call, refresh])

          const runSpoof = useCallback(async () => {
            setBusy('spoof')
            setSpoof(null)
            try {
              const result = await call('/zen/spoof', { method: 'POST', body: '{}' })
              setSpoof(result)
            } catch (failure) {
              setError(String(failure?.message ?? failure))
            } finally {
              setBusy(null)
              await refresh()
            }
          }, [call, refresh])

          const switchFamily = useCallback(async (family) => {
            setBusy('family')
            try {
              const state = await call('/zen/family', {
                method: 'POST',
                body: JSON.stringify({ family }),
              })
              setSnapshot(state)
            } catch (failure) {
              setError(String(failure?.message ?? failure))
            } finally {
              setBusy(null)
            }
          }, [call])

          const buckets = snapshot?.buckets ?? null
          const current = snapshot?.family ?? 'auto'

          return h('div', { className: 'zen-panel' },
            h('style', null, STYLE),
            error !== null && h('div', { className: 'zen-dead' },
              `Статус-эндпоинт недоступен: ${error}`),
            snapshot !== null && h('div', { className: 'zen-row' },
              h('span', null, 'Сброс квоты: '),
              h('span', { className: 'zen-num' },
                `${formatDuration((snapshot.resetAt ?? 0) - now)} (${formatClock(snapshot.resetAt ?? now)})`),
              h('button', { className: 'zen-btn', onClick: refresh, disabled: busy !== null }, 'Обновить'),
            ),
            snapshot !== null && h('table', { className: 'zen-table' },
              h('thead', null, h('tr', null,
                h('th', null, 'Семейство'),
                h('th', null, 'Ответов 2xx сегодня'),
                h('th', null, 'Порог'),
                h('th', null, 'Состояние'),
              )),
              h('tbody', null,
                describeBucket(buckets.ipv4, 'ipv4'),
                describeBucket(buckets.ipv6, 'ipv6'),
                describeBucket(buckets.auto, 'auto (системный резолв)'),
              ),
            ),
            h('div', { className: 'zen-row' },
              h('span', null, 'Пин семейства:'),
              h(
                'select',
                {
                  className: 'zen-select',
                  value: current,
                  disabled: snapshot?.familyLocked === true || busy !== null,
                  onChange: (event) => switchFamily(event.target.value),
                },
                h('option', { value: 'auto' }, 'auto — системный резолв'),
                h('option', { value: 'ipv4' }, 'ipv4 — отдельная корзина'),
                h('option', { value: 'ipv6' }, 'ipv6 — отдельная корзина'),
              ),
              snapshot?.familyLocked === true && h('span', { className: 'zen-note' },
                'зафиксировано конфигом/переменной окружения'),
            ),
            h('div', { className: 'zen-row' },
              h('button', { className: 'zen-btn', disabled: busy !== null, onClick: () => runProbe('ipv4') }, 'Проба ipv4'),
              h('button', { className: 'zen-btn', disabled: busy !== null, onClick: () => runProbe('ipv6') }, 'Проба ipv6'),
              h('button', { className: 'zen-btn', disabled: busy !== null, onClick: runSpoof }, 'Спуф x-real-ip (A/B)'),
            ),
            probe !== null && h('div', { className: 'zen-verdict' },
              `Проба ${probe.family} / ${probe.model}: `,
              h('span', { className: probe.status === 200 ? 'zen-ok' : 'zen-dead' }, String(probe.status)),
              probe.type !== null ? ` ${probe.type}` : '',
              ` · ${probe.ms} мс`,
              h('div', { className: 'zen-note' }, String(probe.body ?? probe.error ?? '').slice(0, 240)),
            ),
            spoof !== null && h('div', { className: 'zen-verdict' },
              h('div', null, `A/B: ${spoof.verdict}`),
              h('div', { className: 'zen-note' },
                spoof.probes.map((item) => `${item.spoofIp ?? 'без спуфа'} → ${item.status}`).join(' · ')),
            ),
            h('div', { className: 'zen-note' },
              'Корзины ключуются по сырой строке egress IP: у гейтвея нет заголовков rate-limit, поэтому «порог» — нижняя граница, которую этот процесс увидел сам.',
            ),
            h('div', { className: 'zen-row' },
              h('input', {
                className: 'zen-select',
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
          ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section',
            id: 'dsh-opencode-zen',
            order: 50,
            label: () => 'OpenCode Zen',
          }, ZenPanel))
        }

        const exports = {}
        exports.apply = apply
        exports.inject = []
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
