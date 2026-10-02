'use strict'
/**
 * Quota accounting for the OpenCode Zen anonymous lane.
 *
 * The gateway publishes no rate-limit headers at all (no retry-after, no
 * remaining), so the only trustworthy numbers a client can produce are the ones
 * it counts itself. Two things are worth knowing from the 2026-10-02 audit:
 *
 *   1. The limiter keys the bucket on the raw `x-real-ip` string
 *      (opencode `handler.ts:101`), truncated to the first four IPv6 groups.
 *      An IPv4 egress and an IPv6 egress are therefore INDEPENDENT daily
 *      buckets, while two addresses inside one /64 share one bucket.
 *   2. Every model without its own `rateLimit` shares a single per-IP bucket,
 *      so a request to one model burns the quota of all the others.
 *
 * Because of (1) the counters are kept per address family. The store never
 * guesses an exact daily limit: it records the number of successful responses
 * observed before the first FreeUsageLimitError, which is a lower bound on the
 * real budget (other clients on the same IP also consume it).
 */

const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { homedir } = require('node:os')
const { dirname, join } = require('node:path')

const FAMILIES = ['auto', 'ipv4', 'ipv6']
const KEEP_DAYS = 3

function defaultQuotaFile() {
  if (typeof process.env.DSH_ZEN_QUOTA_FILE === 'string' && process.env.DSH_ZEN_QUOTA_FILE !== '') {
    return process.env.DSH_ZEN_QUOTA_FILE
  }
  const home = process.env.DSH_HOME && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'state', 'dsh-opencode-zen', 'quota.json')
}

// The gateway rolls the bucket at 00:00 UTC, so the day key is the UTC date.
function dayKey(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10)
}

function nextReset(now = Date.now()) {
  const date = new Date(now)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)
}

function normalizeFamily(family) {
  return FAMILIES.includes(family) ? family : 'auto'
}

function emptyBucket() {
  return { ok: 0, daily429: 0, first429: null, byModel: {}, startedAt: null }
}

function emptyStore() {
  return { version: 1, family: 'auto', days: {} }
}

function createQuotaStore({ file, now = Date.now } = {}) {
  const path = file ?? defaultQuotaFile()
  let state = emptyStore()

  function load() {
    try {
      if (!existsSync(path)) return
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      if (parsed && typeof parsed === 'object' && parsed.days && typeof parsed.days === 'object') {
        state = parsed
        state.family = normalizeFamily(state.family)
      }
    } catch { /* a corrupt file must never break the request path */ }
  }

  function bucketFor(date, family, at) {
    const days = state.days
    if (days[date] === undefined) days[date] = {}
    const day = days[date]
    const key = normalizeFamily(family)
    if (day[key] === undefined) day[key] = emptyBucket()
    const bucket = day[key]
    if (typeof bucket.ok !== 'number') bucket.ok = 0
    if (typeof bucket.daily429 !== 'number') bucket.daily429 = 0
    if (typeof bucket.byModel !== 'object' || bucket.byModel === null) bucket.byModel = {}
    // When did this plugin start counting? A 429 seen before that point tells us
    // the bucket was already spent by traffic this process never observed.
    if (bucket.startedAt === null || bucket.startedAt === undefined) bucket.startedAt = at ?? null
    return bucket
  }

  function prune(date) {
    const days = state.days
    const dates = Object.keys(days).sort().reverse()
    for (const key of dates.slice(KEEP_DAYS)) {
      if (key !== date) delete days[key]
    }
  }

  function save() {
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`)
    } catch { /* persistence is best effort */ }
  }

  load()

  return {
    path,

    /** Address family chosen from the settings panel; survives a restart. */
    getFamily() {
      return normalizeFamily(state.family)
    },

    setFamily(family) {
      state.family = normalizeFamily(family)
      save()
      return state.family
    },

    /** A 2xx response was counted by the gateway limiter (track() fires on completion). */
    recordSuccess({ family, model, at = now() }) {
      const date = dayKey(at)
      const bucket = bucketFor(date, family, at)
      bucket.ok += 1
      const key = typeof model === 'string' && model !== '' ? model : 'unknown'
      bucket.byModel[key] = (bucket.byModel[key] ?? 0) + 1
      prune(date)
      save()
    },

    /**
     * FreeUsageLimitError: the daily bucket is spent. The count observed so far
     * is a lower bound on the real budget, which is what the panel reports.
     */
    recordDailyLimit({ family, model, at = now() }) {
      const date = dayKey(at)
      const bucket = bucketFor(date, family, at)
      bucket.daily429 += 1
      if (bucket.first429 === null) {
        bucket.first429 = { at, ok: bucket.ok, model: typeof model === 'string' ? model : null }
      }
      prune(date)
      save()
    },

    snapshot({ family: configured, at = now() } = {}) {
      const date = dayKey(at)
      prune(date)
      const day = state.days[date] ?? {}
      const buckets = {}
      for (const family of FAMILIES) {
        const bucket = day[family]
        if (bucket === undefined) {
          buckets[family] = { ok: 0, daily429: 0, first429: null, byModel: {}, tracked: false, startedAt: null, baselineUnknown: false }
          continue
        }
        buckets[family] = {
          ok: bucket.ok,
          daily429: bucket.daily429,
          first429: bucket.first429,
          byModel: { ...bucket.byModel },
          tracked: true,
          startedAt: bucket.startedAt ?? null,
          // A 429 with zero counted successes means the budget was already gone
          // before this process started watching — the "lower bound" is then 0 and
          // says nothing about the real limit.
          baselineUnknown: bucket.daily429 > 0 && bucket.first429 !== null && bucket.first429.ok === 0,
        }
      }
      return {
        date,
        at,
        resetAt: nextReset(at),
        resetInMs: Math.max(0, nextReset(at) - at),
        family: normalizeFamily(configured),
        buckets,
      }
    },

    reset({ at = now() } = {}) {
      state = emptyStore()
      state.days[dayKey(at)] = {}
      save()
    },
  }
}

module.exports = {
  FAMILIES,
  KEEP_DAYS,
  createQuotaStore,
  dayKey,
  defaultQuotaFile,
  emptyBucket,
  emptyStore,
  nextReset,
  normalizeFamily,
}
