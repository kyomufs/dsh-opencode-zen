'use strict'
/**
 * Local status + diagnostics endpoint.
 *
 * The web settings panel needs live numbers from the host process (the request
 * counters live where the fetch patch lives), so the plugin publishes a tiny
 * read-mostly HTTP endpoint on 127.0.0.1. It is loopback-only, answers JSON,
 * and sends permissive CORS headers because the panel is served from the DSH
 * web origin. Every mutating route is a deliberate diagnostic action (switching
 * the address family, sending one probe request) — there is no remote surface
 * and the listener never binds to a non-loopback address.
 */

const { createServer } = require('node:http')

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    ...CORS_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

async function readJsonBody(req, limit = 4096) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('invalid JSON body')
  }
}

/**
 * @param {object} options
 * @param {number} options.port          preferred port; 0 picks a free one
 * @param {number} [options.portAttempts] how many consecutive ports to try
 * @param {() => object} options.getState current quota snapshot
 * @param {(family: string) => object} options.setFamily switch the pinned family
 * @param {(opts: object) => Promise<object>} options.probe one live probe request
 * @param {(opts: object) => Promise<object>} options.spoofProbe x-real-ip A/B probe
 */
function createStatusServer({ port, portAttempts = 10, getState, setFamily, probe, spoofProbe }) {
  let attempts = 0
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const route = `${req.method} ${url.pathname}`

    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS)
      res.end()
      return
    }

    if (route === 'GET /zen/quota') {
      try {
        sendJson(res, 200, getState())
      } catch (error) {
        sendJson(res, 500, { error: String(error?.message ?? error) })
      }
      return
    }

    if (route === 'POST /zen/family') {
      readJsonBody(req)
        .then((body) => sendJson(res, 200, setFamily(String(body.family ?? 'auto'))))
        .catch((error) => sendJson(res, 400, { error: String(error?.message ?? error) }))
      return
    }

    if (route === 'POST /zen/probe') {
      readJsonBody(req)
        .then((body) => probe({ family: body.family, model: body.model, spoofIp: body.spoofIp }))
        .then((result) => sendJson(res, 200, result))
        .catch((error) => sendJson(res, 502, { error: String(error?.message ?? error) }))
      return
    }

    if (route === 'POST /zen/spoof') {
      readJsonBody(req)
        .then((body) => spoofProbe({ family: body.family, model: body.model }))
        .then((result) => sendJson(res, 200, result))
        .catch((error) => sendJson(res, 502, { error: String(error?.message ?? error) }))
      return
    }

    sendJson(res, 404, { error: 'unknown route', route })
  })

  async function listen() {
    for (;;) {
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject)
          server.listen(port + attempts, '127.0.0.1', resolve)
        })
        const address = server.address()
        return { url: `http://127.0.0.1:${address.port}`, port: address.port }
      } catch (error) {
        if (error?.code !== 'EADDRINUSE' || attempts >= portAttempts) throw error
        attempts += 1
      }
    }
  }

  return {
    listen,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

module.exports = { createStatusServer, CORS_HEADERS }
