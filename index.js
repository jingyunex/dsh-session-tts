// dsh-session-tts · Host half
// Reads DSH session content aloud with Microsoft Edge's online neural voices.
// The browser half owns playback; this half only produces audio.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-session-tts'

export const inject = ['webServer', 'sessions']

const P = '/dsh-session-tts'

// Used only when the live voice catalogue cannot be fetched.
// The Edge Read Aloud channel only carries two Mandarin female voices.
const EDGE_FALLBACK = [
  { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓', nameEn: 'zh-CN-XiaoxiaoNeural', locale: 'zh-CN', localeLabel: '普通话', gender: 'female' },
  { id: 'zh-CN-XiaoyiNeural', name: '晓伊', nameEn: 'zh-CN-XiaoyiNeural', locale: 'zh-CN', localeLabel: '普通话', gender: 'female' },
]

const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const SETTINGS_PATH = join(DSH_HOME, 'session-tts.json')

const DEFAULTS = () => ({
  edgeVoice: 'zh-CN-XiaoxiaoNeural',
  rate: 1,
  pitch: 0,
  autoTone: true,
  autoRead: false,
  maxChars: 1500,
})

// ---------------------------------------------------------------------------
// Automatic tone
// The TTS model does not read emotion, so a cheap classifier decides how each
// sentence should be delivered, and those decisions become prosody offsets.
// ---------------------------------------------------------------------------
const TONE_PROSODY = {
  natural: { rate: 1.0, pitch: 0 },
  gentle: { rate: 0.94, pitch: -6 },
  serious: { rate: 1.0, pitch: -12 },
  lively: { rate: 1.08, pitch: 12 },
  low: { rate: 0.9, pitch: -18 },
  question: { rate: 1.02, pitch: 6 },
}

const WORD_CUES = [
  { tone: 'low', words: ['遗憾', '抱歉', '对不起', '可惜', '失败', '出错', '错误', '报错', '崩溃', '挂了', '难过', '糟糕', '没办法', '做不到', '踩坑', '白折腾', '卡住'] },
  { tone: 'lively', words: ['太好了', '成功', '搞定', '完成', '通过', '恭喜', '漂亮', '终于', '可以了', '好耶', '没问题', '解决了', '跑通了'] },
  { tone: 'serious', words: ['注意', '重要', '警告', '必须', '务必', '风险', '危险', '切勿', '禁止', '严禁'] },
  { tone: 'gentle', words: ['谢谢', '辛苦', '麻烦你', '别担心', '放心', '慢慢来', '没关系', '不着急', '随时'] },
]

function classifySentence(sentence) {
  const text = String(sentence)
  for (const cue of WORD_CUES) {
    if (cue.words.some((word) => text.includes(word))) return cue.tone
  }
  if (/[!！]{1,}/.test(text)) return 'lively'
  // A trailing ellipsis reads as hesitation; check before the question mark so
  // "会不会……？" stays hesitant rather than turning into a plain question.
  if (/(…|\.\.\.|~)/.test(text)) return 'low'
  if (/[?？]\s*$/.test(text)) return 'question'
  return 'natural'
}

// Split keeping the terminator, so prosody is not chopped mid-thought.
// `…` is deliberately NOT a terminator: splitting it would break the `……` pair
// that the hesitation cue depends on.
function splitSentences(text) {
  const raw = String(text)
    .split(/(?<=[。！？!?；;\n])/)
    .map((part) => part.trim())
    .filter(Boolean)
  const merged = []
  for (const part of raw) {
    const prev = merged[merged.length - 1]
    // A 3-character fragment read on its own sounds broken; glue it forward.
    if (prev && prev.length < 6) merged[merged.length - 1] = prev + part
    else merged.push(part)
  }
  if (merged.length > 1 && merged[merged.length - 1].length < 6) {
    const tail = merged.pop()
    merged[merged.length - 1] += tail
  }
  return merged
}

function planTones(text, baseRate, basePitch, maxGroups = 6) {
  const sentences = splitSentences(text)
  if (!sentences.length) {
    return [{ tone: 'natural', text, rate: baseRate, pitch: basePitch }]
  }
  const planned = sentences.map((sentence) => ({ tone: classifySentence(sentence), text: sentence }))
  const groups = []
  for (const item of planned) {
    const last = groups[groups.length - 1]
    if (last && last.tone === item.tone) last.text += item.text
    else groups.push({ tone: item.tone, text: item.text })
  }
  // Collapse the weakest boundaries until the request count is bounded; more
  // groups means more round trips, and latency matters more than nuance.
  while (groups.length > maxGroups) {
    let weakest = 0
    for (let i = 1; i < groups.length - 1; i++) {
      if (groups[i].text.length < groups[weakest].text.length) weakest = i
    }
    const a = groups[weakest]
    const b = groups[weakest + 1]
    a.text = a.text + b.text
    groups.splice(weakest + 1, 1)
  }
  return groups.map((group) => {
    const prosody = TONE_PROSODY[group.tone] || TONE_PROSODY.natural
    return {
      tone: group.tone,
      text: group.text,
      rate: Math.min(2, Math.max(0.5, baseRate * prosody.rate)),
      pitch: Math.min(50, Math.max(-50, basePitch + prosody.pitch)),
    }
  })
}

// MP3 frames are independently decodable, so segments can be joined after
// dropping each later segment's ID3 header and any ID3v1 trailer.
function stripId3(buffer, isFirst) {
  let start = 0
  let end = buffer.length
  if (!isFirst && buffer.length > 10 && buffer.toString('latin1', 0, 3) === 'ID3') {
    const flags = buffer[5]
    const size = ((buffer[6] & 0x7f) << 21) | ((buffer[7] & 0x7f) << 14) | ((buffer[8] & 0x7f) << 7) | (buffer[9] & 0x7f)
    start = Math.min(buffer.length, 10 + size + (flags & 0x10 ? 10 : 0))
  }
  if (end > 128 && buffer.toString('latin1', end - 128, end - 125) === 'TAG') end -= 128
  return buffer.subarray(start, end)
}

function concatMp3(buffers) {
  const parts = buffers.map((buffer, index) => stripId3(buffer, index === 0))
  return Buffer.concat(parts)
}

function loadSettings() {
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'))
    const merged = { ...DEFAULTS(), ...(raw && typeof raw === 'object' ? raw : {}) }
    // Drop fields left behind by the retired offline engine.
    delete merged.engine
    delete merged.kokoroVoice
    delete merged.cacheDir
    return merged
  } catch {
    return DEFAULTS()
  }
}

function saveSettings(next) {
  try {
    mkdirSync(DSH_HOME, { recursive: true })
    writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2), 'utf8')
    return true
  } catch (error) {
    console.error('[session-tts] save settings failed: ' + String(error && error.message))
    return false
  }
}

// ---------------------------------------------------------------------------
// Edge (online) engine — the same Microsoft Read Aloud channel the Harness
// itself uses. edge-tts-universal hangs on this network; msedge-tts connects.
// ---------------------------------------------------------------------------
let edgeSdk = null
async function msedge() {
  if (!edgeSdk) {
    const mod = await import('msedge-tts')
    edgeSdk = mod.default ?? mod
  }
  return edgeSdk
}

async function edgeSynth(text, voiceId, rate, pitchHz) {
  const sdk = await msedge()
  const tts = new sdk.MsEdgeTTS({ connectionTimeoutMs: 15000, synthesisTimeoutMs: 45000 })
  await tts.setMetadata(voiceId, sdk.OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
  const hz = Math.round(Number(pitchHz) || 0)
  const pitch = (hz >= 0 ? '+' : '') + hz + 'Hz'
  const { audioStream } = tts.toStream(text, { rate: Number(rate) || 1, pitch })
  const chunks = []
  await new Promise((resolve, reject) => {
    audioStream.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    audioStream.on('close', resolve)
    audioStream.on('end', resolve)
    audioStream.on('error', reject)
  })
  const buffer = Buffer.concat(chunks)
  if (!buffer.length) throw new Error('edge returned no audio')
  return { buffer, mime: 'audio/mpeg' }
}

// Friendly Chinese names for the Standard/Mainland and dialect voices; unknown
// ids fall back to the short English name from Microsoft's catalogue.
const VOICE_NAMES = {
  'zh-CN-XiaoxiaoNeural': '晓晓',
  'zh-CN-XiaoyiNeural': '晓伊',
  'zh-CN-YunjianNeural': '云健',
  'zh-CN-YunxiNeural': '云希',
  'zh-CN-YunxiaNeural': '云夏',
  'zh-CN-YunyangNeural': '云扬',
  'zh-CN-liaoning-XiaobeiNeural': '晓北',
  'zh-CN-shaanxi-XiaoniNeural': '晓妮',
  'zh-HK-HiuGaaiNeural': '曉佳',
  'zh-HK-HiuMaanNeural': '曉曼',
  'zh-HK-WanLungNeural': '雲龍',
  'zh-TW-HsiaoChenNeural': '曉臻',
  'zh-TW-HsiaoYuNeural': '曉雨',
  'zh-TW-YunJheNeural': '雲哲',
}

const LOCALE_LABELS = {
  'zh-CN': '普通话',
  'zh-CN-liaoning': '东北官话',
  'zh-CN-shaanxi': '中原官话 · 陕西',
  'zh-HK': '粤语',
  'zh-TW': '台湾国语',
}

function shortName(friendly, id) {
  const named = VOICE_NAMES[id]
  if (named) return named
  const first = String(friendly || '')
    .replace(/^Microsoft\s+/, '')
    .split(/\s+Online|\s+\(/)[0]
    .trim()
  return first || id
}

let cachedEdgeVoices = null
async function edgeVoices() {
  if (cachedEdgeVoices) return cachedEdgeVoices
  try {
    const sdk = await msedge()
    const tts = new sdk.MsEdgeTTS()
    const list = await tts.getVoices()
    const mapped = (Array.isArray(list) ? list : [])
      .map((v) => {
        const id = String(v.ShortName || '')
        const locale = String(v.Locale || '')
        return {
          id,
          name: shortName(v.FriendlyName, id),
          nameEn: id,
          locale,
          localeLabel: LOCALE_LABELS[locale] || locale,
          gender: String(v.Gender || '').toLowerCase(),
        }
      })
      // Mandarin only: `zh-CN` exactly, so the Liaoning / Shaanxi / Cantonese /
      // Taiwan locales that also start with `zh` stay out of the picker.
      .filter((v) => v.id && /^zh-CN$/i.test(v.locale || '') && v.gender !== 'male')
    if (mapped.length) {
      cachedEdgeVoices = mapped
      return mapped
    }
  } catch (error) {
    console.warn('[session-tts] edge voice list failed: ' + String(error && error.message))
  }
  cachedEdgeVoices = EDGE_FALLBACK
  return cachedEdgeVoices
}

// ---------------------------------------------------------------------------
// Session text
// ---------------------------------------------------------------------------
function textOfBlocks(message) {
  const parts = []
  if (message && Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        parts.push(block.text.trim())
      }
    }
  }
  return parts.join('\n\n')
}

function eventsOf(session) {
  try {
    return session.snapshotEvents(0) || []
  } catch {
    return []
  }
}

function messageText(session, messageId) {
  const events = eventsOf(session)
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (!ev || ev.type !== 'assistant/message') continue
    const m = ev.data && ev.data.message
    if (!m || String(m.id) !== String(messageId)) continue
    return textOfBlocks(m)
  }
  return ''
}

// The desktop slot hands over only a messageId, so fall back to scanning every
// loaded session until one owns that id.
function locate(sessions, sessionId, messageId) {
  const tried = []
  const add = (id) => {
    const s = String(id || '')
    if (s && tried.indexOf(s) < 0) tried.push(s)
  }
  add(sessionId)
  try {
    for (const s of sessions.list()) add(s.id)
  } catch {
    /* ignore */
  }
  for (const id of tried) {
    const session = sessions.get(id)
    if (!session) continue
    const text = messageText(session, messageId)
    if (text) return { sessionId: id, text }
  }
  return null
}

function sessionSegments(session) {
  const events = eventsOf(session)
  const out = []
  for (const ev of events) {
    if (!ev || ev.type !== 'assistant/message') continue
    const text = textOfBlocks(ev.data && ev.data.message)
    if (text) out.push(text)
  }
  return out
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------
export function apply(ctx) {
  const settings = loadSettings()
  const audio = new Map()

  const storeAudio = (buffer, mime) => {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    audio.set(id, { buffer, mime, at: Date.now() })
    for (const [key, value] of audio) {
      if (Date.now() - value.at > 10 * 60 * 1000) audio.delete(key)
    }
    return id
  }

  const synthesize = async (rawText, overrides = {}) => {
    const text = String(rawText == null ? '' : rawText).trim()
    if (!text) throw new Error('empty text')
    const limit = Number(overrides.maxChars) > 0 ? Number(overrides.maxChars) : settings.maxChars
    const clipped = limit > 0 ? text.slice(0, limit) : text
    const rate = Number(overrides.rate) > 0 ? Number(overrides.rate) : settings.rate
    const pitch = Number.isFinite(Number(overrides.pitch)) ? Number(overrides.pitch) : settings.pitch
    const voice = overrides.voice || settings.edgeVoice
    const autoTone = typeof overrides.autoTone === 'boolean' ? overrides.autoTone : settings.autoTone

    let buffer
    let plan = null
    if (autoTone) {
      plan = planTones(clipped, rate, pitch)
      const parts = await Promise.all(plan.map((group) => edgeSynth(group.text, voice, group.rate, group.pitch)))
      buffer = concatMp3(parts.map((part) => part.buffer))
    } else {
      buffer = (await edgeSynth(clipped, voice, rate, pitch)).buffer
    }

    const id = storeAudio(buffer, 'audio/mpeg')
    return {
      id,
      mime: 'audio/mpeg',
      bytes: buffer.length,
      url: P + '/audio?id=' + id,
      chars: text.length,
      autoTone,
      plan: plan ? plan.map((group) => ({ tone: group.tone, chars: group.text.length, rate: Number(group.rate.toFixed(2)), pitch: group.pitch })) : null,
    }
  }

  const json = (res, code, payload) => {
    const body = JSON.stringify(payload)
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  const readJson = (req) =>
    new Promise((resolve) => {
      let raw = ''
      req.on('data', (chunk) => {
        raw += chunk
        if (raw.length > 2_000_000) req.destroy()
      })
      req.on('end', () => {
        try {
          resolve(JSON.parse(raw || '{}'))
        } catch {
          resolve({})
        }
      })
      req.on('error', () => resolve({}))
    })

  const route = (path, handler) =>
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path,
        handler: async (req, res) => {
          try {
            await handler(req, res)
          } catch (error) {
            const message = String((error && error.message) || error)
            console.error('[session-tts] ' + path + ' failed: ' + message)
            try {
              json(res, 500, { ok: false, error: message })
            } catch {
              /* response already sent */
            }
          }
        },
      }),
    )

  const publicSettings = () => ({
    edgeVoice: settings.edgeVoice,
    rate: settings.rate,
    pitch: settings.pitch,
    autoTone: settings.autoTone,
    autoRead: settings.autoRead,
    maxChars: settings.maxChars,
  })

  // The picker only lists female voices; if a stored voice is no longer offered
  // (for example a male voice kept from an older version), fall back to the first.
  const reconcileVoice = async () => {
    const list = await edgeVoices()
    if (!list.length) return
    if (list.some((v) => v.id === settings.edgeVoice)) return
    settings.edgeVoice = list[0].id || DEFAULT_VOICE
    saveSettings(settings)
  }

  route(P + '/settings', async (req, res) => {
    if (req.method === 'POST') {
      const body = await readJson(req)
      if (typeof body.edgeVoice === 'string' && body.edgeVoice.trim()) {
        const known = await edgeVoices()
        const wanted = body.edgeVoice.trim()
        if (known.some((v) => v.id === wanted) || !known.length) settings.edgeVoice = wanted
      }
      if (Number.isFinite(Number(body.rate))) settings.rate = Math.min(2, Math.max(0.5, Number(body.rate)))
      if (Number.isFinite(Number(body.pitch))) settings.pitch = Math.min(50, Math.max(-50, Number(body.pitch)))
      if (typeof body.autoTone === 'boolean') settings.autoTone = body.autoTone
      if (typeof body.autoRead === 'boolean') settings.autoRead = body.autoRead
      if (Number.isFinite(Number(body.maxChars))) settings.maxChars = Math.min(8000, Math.max(100, Number(body.maxChars)))
      saveSettings(settings)
      json(res, 200, { ok: true, settings: publicSettings() })
      return
    }
    await reconcileVoice()
    json(res, 200, { ok: true, settings: publicSettings() })
  })

  route(P + '/voices', async (req, res) => {
    try {
      await reconcileVoice()
      json(res, 200, { ok: true, engine: 'edge', voices: await edgeVoices() })
    } catch (error) {
      json(res, 502, { ok: false, error: String((error && error.message) || error), voices: EDGE_FALLBACK })
    }
  })

  // One-shot synthesis: explicit text, one message id, or a session segment.
  route(P + '/speak', async (req, res) => {
    if (req.method !== 'POST') {
      json(res, 405, { ok: false, error: 'POST required' })
      return
    }
    const body = await readJson(req)
    let text = typeof body.text === 'string' ? body.text : ''
    if (!text && body.messageId) {
      const hit = locate(ctx.sessions, body.sessionId, body.messageId)
      if (!hit) {
        json(res, 404, { ok: false, error: 'message not found in any loaded session' })
        return
      }
      text = hit.text
    }
    if (!text.trim()) {
      json(res, 400, { ok: false, error: 'nothing to read' })
      return
    }
    const result = await synthesize(text, {
      voice: body.voice,
      rate: body.rate,
      pitch: body.pitch,
      maxChars: body.maxChars,
      autoTone: body.autoTone,
    })
    json(res, 200, { ok: true, ...result })
  })

  route(P + '/sessions', async (req, res) => {
    const list = []
    try {
      for (const session of ctx.sessions.list()) {
        let seq = 0
        try {
          seq = Number(session.seq) || 0
        } catch {
          /* ignore */
        }
        list.push({ id: String(session.id), seq })
      }
    } catch (error) {
      json(res, 500, { ok: false, error: String((error && error.message) || error) })
      return
    }
    json(res, 200, { ok: true, count: list.length, sessions: list })
  })

  // Whole-session text, split into readable segments the browser plays in order.
  route(P + '/session-text', async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const sessionId = url.searchParams.get('sessionId')
    const session = sessionId ? ctx.sessions.get(sessionId) : undefined
    if (!session) {
      let known = []
      try {
        known = ctx.sessions.list().map((s) => String(s.id))
      } catch {
        /* ignore */
      }
      json(res, 404, { ok: false, error: 'session not found', requested: sessionId, known })
      return
    }
    const segments = sessionSegments(session)
    json(res, 200, { ok: true, sessionId: String(sessionId), count: segments.length, segments })
  })

  route(P + '/status', async (req, res) => {
    const voices = await edgeVoices()
    json(res, 200, {
      ok: true,
      engine: 'edge',
      settings: publicSettings(),
      voices: {
        total: voices.length,
        chinese: voices.filter((v) => /^zh/i.test(v.locale || '')).length,
        female: voices.filter((v) => v.gender === 'female').length,
      },
    })
  })

  route(P + '/audio', async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const id = url.searchParams.get('id')
    const hit = id ? audio.get(id) : null
    if (!hit) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('audio not found')
      return
    }
    res.writeHead(200, {
      'content-type': hit.mime,
      'content-length': String(hit.buffer.length),
      'cache-control': 'no-store',
    })
    res.end(hit.buffer)
  })

  ctx.effect(() => () => {
    audio.clear()
  })

  console.log('[session-tts] ready at ' + P + ' (engine=edge, voice=' + settings.edgeVoice + ')')
}
