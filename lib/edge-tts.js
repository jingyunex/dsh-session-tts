// Minimal Microsoft Edge Read Aloud client.
//
// Owned by this plugin instead of depending on a third-party wrapper: the public
// handshake keeps changing, and the wrappers lag behind it. Two things the
// service now requires:
//   1. `Sec-MS-GEC-Version` with a `2-` prefix (it was `1-`).
//   2. A "v2" `Sec-MS-GEC` token: "<16 hex>-<64 hex>", where the first half is a
//      CS64 digest and the second half is a *decorated* SHA-256 (custom initial
//      state, one replaced round constant, pre-seeded schedule).
// The `api.msedgeservices.com` host rejects the public token outright, so this
// client talks to the classic `speech.platform.bing.com` endpoint.

import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { WebSocket } = require('ws')

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const WSS_URL = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'
const VOICES_URL =
  'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list' +
  `?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`
const CHROMIUM_VERSION = '143.0.3650.96'
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3'
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0'
const ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold'
const CRLF2 = '\r\n\r\n'

// ---------------------------------------------------------------- primitives
const M32 = 0xffffffff
const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0
const big1 = (x) => (rotr(x, 6) ^ rotr(x, 11) ^ rotr(x, 25)) >>> 0
const big0 = (x) => (rotr(x, 2) ^ rotr(x, 13) ^ rotr(x, 22)) >>> 0
const small1 = (x) => (rotr(x, 17) ^ rotr(x, 19) ^ (x >>> 10)) >>> 0
const small0 = (x) => (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0
const mul32 = (a, b) => Math.imul(a, b) >>> 0
const rol16 = (v) => (((v << 16) | (v >>> 16)) >>> 0)

// ------------------------------------------------------- decorated SHA-256
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]
const K_BLOCK = K.slice()
K_BLOCK[14] = 0xc9dc06a7
const INIT_STATE = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
const SEED_STATE = [0xfd9fbea2, 0x91243ce7, 0xbe499094, 0xcd2e1e0a, 0x6c006f49, 0x04bd35ab, 0xfeb0a7e4, 0x03effbd2]
const SEED_SCHEDULE = [
  0xeb24bf9e, 0x1558691f, 0xa0c09ee2, 0x0cfa32ba, 0xa622ee8c, 0xd1dd9491,
  0xc0dd25a0, 0xf9e70ab6, 0xf0c31573, 0x7058ce4e, 0x7188e606, 0x00e5ab33,
  0xd258b060, 0x72766564,
]
const SIGMA0_ADJ = 0x059c0b80
const SIGMA1_ADJ = 0x000b92c0
const ADJUSTMENT = 0xc9dc06a7

function compress(state, W, seeded) {
  let [a, b, c, d, e, f, g, h] = state
  const kk = seeded ? K_BLOCK : K
  // The seed state already covers rounds 0..13, so a seeded block starts at 14.
  for (let i = seeded ? 14 : 0; i < 64; i++) {
    const t1 = (h + big1(e) + (g ^ (e & (f ^ g))) + kk[i] + W[i]) >>> 0
    const t2 = (big0(a) + ((a & b) | (c & (a | b)))) >>> 0
    h = g
    g = f
    f = e
    e = (d + t1) >>> 0
    d = c
    c = b
    b = a
    a = (t1 + t2) >>> 0
  }
  return [a, b, c, d, e, f, g, h]
}

function expand(W, first) {
  for (let i = first; i < 64; i++) {
    W[i] = (W[i - 16] + small0(W[i - 15]) + W[i - 7] + small1(W[i - 2])) >>> 0
  }
}

function seedStateFrom7(bytes7) {
  const W = new Array(64).fill(0)
  W[14] = (bytes7[0] << 16) | (bytes7[1] << 8) | bytes7[2]
  W[15] = (((bytes7[3] << 24) | (bytes7[4] << 16) | (bytes7[5] << 8) | bytes7[6]) >>> 0)
  for (let i = 16; i <= 29; i++) {
    let v = SEED_SCHEDULE[i - 16]
    v = (v + (i === 16 ? small1(W[i - 2]) ^ SIGMA1_ADJ : small1(W[i - 2]))) >>> 0
    if (i - 7 >= 14) v = (v + W[i - 7]) >>> 0
    if (i - 15 >= 14) v = (v + (i === 29 ? small0(W[i - 15]) ^ SIGMA0_ADJ : small0(W[i - 15]))) >>> 0
    W[i] = v >>> 0
  }
  W[30] = (small1(W[28]) + W[23] + small0(W[15]) + W[14] + ADJUSTMENT - K[14]) >>> 0
  expand(W, 31)
  const work = compress(SEED_STATE, W, true)
  return work.map((x, i) => (x + INIT_STATE[i]) >>> 0)
}

function decoratedSha256(data) {
  const length = 57 + data.length
  let padLen = (55 - length) % 64
  if (padLen < 0) padLen += 64
  const bits = Buffer.alloc(8)
  bits.writeUInt32BE(Math.floor((length * 8) / 0x100000000), 0)
  bits.writeUInt32BE((length * 8) >>> 0, 4)
  const padded = Buffer.concat([data.subarray(7), Buffer.from([0x80]), Buffer.alloc(padLen), bits])
  let state = seedStateFrom7(data.subarray(0, 7))
  for (let off = 0; off < padded.length; off += 64) {
    const W = new Array(64)
    for (let j = 0; j < 16; j++) W[j] = padded.readUInt32BE(off + j * 4)
    expand(W, 16)
    const work = compress(state, W, false)
    state = state.map((x, i) => (x + work[i]) >>> 0)
  }
  const out = Buffer.alloc(32)
  state.forEach((x, i) => out.writeUInt32BE(x, i * 4))
  return out
}

// --------------------------------------------------------------- CS64 digest
const COEFFICIENTS = [
  [0xe82e91b1, 0xb32700d0], [0x44de24c6, 0x88dff51d], [0x3beb65bc, 0x29514038],
  [0xc89c5933, 0xb328cbdf], [0x8d1ec211, 0xd405b4d5], [0x314ef5d5, 0x26e55f3c],
  [0xe92491b1, 0x607801c6], [0xf0a5b9d5, 0x82b2c1fb], [0x06064cf3, 0xfa51a3da],
  [0xda79fa60, 0x207cc464], [0xbed20560, 0x3c3c74f3], [0x89f9c9f8, 0xd2d14b61],
  [0x35fa38c6, 0xbb04a2c1], [0xcb49e3c6, 0xc5626167],
]

function cs64Digest(data, digest) {
  const keyA = digest.readUInt32LE(0) | 1
  const keyB = digest.readUInt32LE(4) | 1
  const factors = [mul32(keyA, 0x82893933), mul32(keyB, 0x82893933)]
  const terms = []
  const offsets = []
  for (let i = 0; i < COEFFICIENTS.length; i++) {
    terms.push(mul32(COEFFICIENTS[i][0], factors[i % 2]))
    offsets.push(COEFFICIENTS[i][1])
  }
  const payload = Buffer.concat([Buffer.from([0]), data])
  const padded = Buffer.concat([payload, Buffer.alloc((4 - (payload.length % 4)) % 4)])
  const words = []
  for (let i = 0; i < padded.length; i += 4) words.push(padded.readUInt32LE(i))
  if (words.length % 2) words.push(0)
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    let term = mul32(word, i % 2 === 0 ? keyA : keyB)
    let offset = mul32(rol16(word), i % 2 === 0 ? 0xef0569fb : 0xc31713db)
    if (i === 0) {
      term = (term + mul32(0xf2f90b1a, factors[0])) >>> 0
      offset = (offset + 0x0b1a0000) >>> 0
    }
    terms.push(term >>> 0)
    offsets.push(offset >>> 0)
  }
  let swapAcc = 0
  let swapLast = 0
  let state = 0
  let acc = 0
  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i]
    const y = terms[i + 1]
    let t = rol16((offsets[i] + x) >>> 0)
    let q = mul32(t, 0x76f50f34)
    swapAcc = (swapAcc + ((mul32(rol16(q), 0xc3efea97) + q) >>> 0)) >>> 0

    t = rol16((offsets[i + 1] + y) >>> 0)
    q = mul32(t, 0x1881ce3c)
    swapLast = (mul32(rol16(q), 0x35bd1ec9) + q) >>> 0
    swapAcc = (swapAcc + swapLast) >>> 0

    state = (mul32(state, keyA) + x) >>> 0
    state = mul32(rol16(state), 0xcf98b111)
    state = mul32(rol16(state), 0x87085b9f)
    state = mul32(rol16(state), 0x12ceb96d)
    state = mul32(rol16(state), 0x257e1d83)
    acc = (acc + state) >>> 0

    t = (mul32(state, keyB) + y) >>> 0
    t = mul32(rol16(t), 0xa27416f5)
    t = mul32(rol16(t), 0xd38396ff)
    state = mul32(rol16(mul32(rol16(t), 0x7c932b89)), 0xbfa49f69)
    acc = (acc + state) >>> 0
  }
  return [(swapLast ^ state) >>> 0, (swapAcc ^ acc) >>> 0]
}

/**
 * Build the v2 `Sec-MS-GEC` token for a UNIX timestamp.
 * Exported so the value can be checked against the reference implementation.
 */
export function generateSecMsGec(unixSeconds) {
  let ticks = Math.floor(Number(unixSeconds)) + 11644473600
  ticks -= ticks % 300
  ticks = ticks * 1e7
  const data = Buffer.from(`${ticks}${TRUSTED_CLIENT_TOKEN}`, 'ascii')
  const digest = decoratedSha256(data)
  const [a, b] = cs64Digest(data, digest)
  const cs = Buffer.alloc(8)
  cs.writeUInt32LE(a, 0)
  cs.writeUInt32LE(b, 4)
  return `${cs.toString('hex').toUpperCase()}-${digest.toString('hex').toUpperCase()}`
}

// ------------------------------------------------------------------ transport
function requestId() {
  return randomBytes(16).toString('hex')
}

function synthUrl() {
  const token = generateSecMsGec(Date.now() / 1000)
  return (
    `${WSS_URL}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
    `&Sec-MS-GEC=${encodeURIComponent(token)}` +
    `&Sec-MS-GEC-Version=2-${CHROMIUM_VERSION}` +
    `&ConnectionId=${requestId()}`
  )
}

function localeOf(voice) {
  const hit = /\b[a-z]{2,}-[A-Z]{2}\b/.exec(String(voice))
  return hit ? hit[0] : 'zh-CN'
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function rateValue(rate) {
  const r = Number(rate)
  if (!Number.isFinite(r) || r <= 0) return '1'
  return String(Math.round(r * 100) / 100)
}

function pitchValue(pitch) {
  const hz = Math.round(Number(pitch) || 0)
  return (hz >= 0 ? '+' : '') + hz + 'Hz'
}

/**
 * Synthesize one chunk of text and resolve with the concatenated MP3 bytes.
 */
export function synthesize(text, voice, { rate = 1, pitch = 0, timeoutMs = 45000 } = {}) {
  const ssml =
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${localeOf(voice)}">` +
    `<voice name="${escapeXml(voice)}">` +
    `<prosody pitch="${pitchValue(pitch)}" rate="${rateValue(rate)}" volume="+0%">${escapeXml(text)}</prosody>` +
    `</voice></speak>`

  return new Promise((resolve, reject) => {
    const chunks = []
    let settled = false
    const ws = new WebSocket(synthUrl(), {
      headers: { 'User-Agent': USER_AGENT, Origin: ORIGIN },
      handshakeTimeout: 15000,
    })

    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        if (ws.readyState === ws.OPEN) ws.close()
        else if (typeof ws.terminate === 'function') ws.terminate()
      } catch {
        /* ignore */
      }
      if (error) reject(error)
      else resolve(Buffer.concat(chunks))
    }

    const timer = setTimeout(() => finish(new Error('Edge TTS timed out')), timeoutMs)

    ws.on('open', () => {
      const config =
        `X-RequestId:${requestId()}\r\n` +
        `Content-Type:application/json; charset=utf-8\r\n` +
        `Path:speech.config${CRLF2}` +
        JSON.stringify({
          context: {
            synthesis: {
              audio: {
                metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
                outputFormat: OUTPUT_FORMAT,
              },
            },
          },
        })
      ws.send(config, (err) => {
        if (err) return finish(err)
        const request =
          `X-RequestId:${requestId()}\r\n` +
          `Content-Type:application/ssml+xml\r\n` +
          `Path:ssml${CRLF2}${ssml}`
        ws.send(request, (e) => e && finish(e))
      })
    })

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const buf = Buffer.from(data)
        const at = buf.indexOf('Path:audio\r\n')
        if (at !== -1) chunks.push(buf.subarray(at + 'Path:audio\r\n'.length))
        return
      }
      const msg = data.toString()
      if (msg.includes('Path:turn.end')) {
        if (!chunks.length) finish(new Error('Edge TTS returned no audio'))
        else finish(null)
      }
    })

    ws.on('unexpected-response', (_req, res) => {
      finish(new Error(`Edge TTS handshake rejected: HTTP ${res.statusCode}`))
    })
    ws.on('error', (err) => finish(err instanceof Error ? err : new Error(String(err))))
    ws.on('close', () => {
      if (!settled) finish(chunks.length ? null : new Error('Edge TTS closed before audio arrived'))
    })
  })
}

/**
 * Fetch the full voice catalogue (the classic host still serves it over HTTPS).
 */
export async function listVoices() {
  const res = await fetch(VOICES_URL, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) throw new Error(`voice list failed: HTTP ${res.status}`)
  const list = await res.json()
  return Array.isArray(list) ? list : []
}
