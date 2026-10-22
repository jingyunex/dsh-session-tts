window.__ModuleLoader__.load({
  id: 'dsh-session-tts',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const BASE = '/dsh-session-tts'
    const SPEAK_ACTION_ID = 'session-tts'
    const DOCK_ID = 'session-tts-dock'
    const SETTINGS_ID = 'session-tts'

    // ---------------------------------------------------------------- i18n
    const DICT = {
      zh: {
        settingsTitle: '语音朗读',
        settingsHint: '用微软 Edge 的在线神经网络语音朗读会话回复。点音色即可试听。',
        voice: '音色',
        tone: '语气',
        toneHint: '语气 = 语速 + 音高的组合。自动语气只调整语速，音高始终用下面的设定。',
        pitch: '音高',
        autoTone: '自动语气',
        autoToneOn: '开：按句自动判断情绪，分别调整语速音高',
        autoToneOff: '关：整段用上面选定的语气',
        rate: '语速',
        autoRead: '自动朗读新回复',
        preview: '试听',
        stop: '停止',
        sample: '主人，本鲸正在用这个音色朗读。',
        loading: '加载中…',
        readThis: '朗读这条回复',
        stopReading: '停止朗读',
        readSession: '朗读本会话',
        reading: '正在朗读',
        idle: '待命',
        failed: '失败',
        noVoice: '没有可选音色',
        sessionEmpty: '这个会话还没有可朗读的回复',
        needTap: '手机浏览器需要先点一下页面才能出声',
        female: '女声',
        male: '男声',
        current: '当前',
      },
      en: {
        settingsTitle: 'Read aloud',
        settingsHint: 'Speak session replies with Microsoft Edge neural voices. Click a voice to preview.',
        voice: 'Voice',
        tone: 'Tone',
        toneHint: 'A tone is rate + pitch. Auto tone only changes rate; pitch stays at the value below.',
        pitch: 'Pitch',
        autoTone: 'Auto tone',
        autoToneOn: 'On: each sentence is classified and gets its own delivery',
        autoToneOff: 'Off: the whole reply uses the tone above',
        rate: 'Rate',
        autoRead: 'Auto-read new replies',
        preview: 'Preview',
        stop: 'Stop',
        sample: 'Hello. This is the selected voice.',
        loading: 'Loading…',
        readThis: 'Read this reply',
        stopReading: 'Stop reading',
        readSession: 'Read this session',
        reading: 'Reading',
        idle: 'Idle',
        failed: 'Failed',
        noVoice: 'No voice available',
        sessionEmpty: 'This session has no reply to read yet',
        needTap: 'Tap the page once so this browser allows audio',
        female: 'female',
        male: 'male',
        current: 'Selected',
      },
    }

    function lang() {
      const raw = (typeof document !== 'undefined' && document.documentElement && document.documentElement.lang) || 'zh'
      return String(raw).toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
    }
    function t(key) {
      const table = DICT[lang()] || DICT.zh
      return table[key] || DICT.zh[key] || key
    }

    // --------------------------------------------------------------- store
    const store = {
      state: { busy: false, playingKey: null, error: null, settings: null, voices: [], queueTotal: 0, queueDone: 0 },
      listeners: new Set(),
    }
    function setState(patch) {
      store.state = Object.assign({}, store.state, patch)
      store.listeners.forEach((fn) => {
        try {
          fn()
        } catch (error) {
          /* ignore a broken listener */
        }
      })
    }
    function useStore() {
      const [, bump] = React.useState(0)
      React.useEffect(() => {
        const fn = () => bump((n) => n + 1)
        store.listeners.add(fn)
        return () => store.listeners.delete(fn)
      }, [])
      return store.state
    }

    // ---------------------------------------------------------------- http
    async function api(path, body) {
      const init = body === undefined ? {} : {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }
      const response = await fetch(BASE + path, init)
      let data = null
      try {
        data = await response.json()
      } catch (error) {
        data = { ok: false, error: 'bad response (' + response.status + ')' }
      }
      if (!response.ok && data && data.ok !== true) {
        throw new Error(data.error || 'request failed (' + response.status + ')')
      }
      if (data && data.ok === false) throw new Error(data.error || 'request failed')
      return data
    }

    // -------------------------------------------------------------- player
    let audio = null
    let runToken = 0

    function audioEl() {
      if (audio) return audio
      audio = new Audio()
      audio.preload = 'auto'
      audio.setAttribute('playsinline', '')
      audio.setAttribute('webkit-playsinline', '')
      audio.addEventListener('ended', () => {
        if (store.state.playingKey && store.state.queueTotal === 0) setState({ playingKey: null, busy: false })
      })
      audio.addEventListener('error', () => {
        if (store.state.playingKey) setState({ playingKey: null, busy: false, error: t('failed') })
      })
      return audio
    }

    // Mobile browsers (iOS Safari, mobile Chrome) refuse play() until the page
    // has received a real user gesture. Prime the element once on the first
    // touch so later timer-driven playback is allowed.
    let unlocked = false
    function unlockAudio() {
      if (unlocked) return
      unlocked = true
      try {
        const el = audioEl()
        el.muted = true
        const played = el.play()
        if (played && typeof played.then === 'function') {
          played.then(() => {
            try {
              el.pause()
              el.muted = false
            } catch (error) {
              /* ignore */
            }
          }).catch(() => {})
        }
      } catch (error) {
        /* ignore */
      }
    }

    function armUnlock() {
      if (typeof document === 'undefined') return () => {}
      const events = ['pointerdown', 'touchstart', 'keydown', 'click']
      const handler = () => unlockAudio()
      events.forEach((name) => document.addEventListener(name, handler, { passive: true, once: true }))
      return () => events.forEach((name) => document.removeEventListener(name, handler))
    }

    function autoplayBlocked(error) {
      const name = error && error.name ? String(error.name) : ''
      return name === 'NotAllowedError' || name === 'NotSupportedError'
    }

    function stopAll() {
      runToken++
      if (audio) {
        try {
          audio.pause()
        } catch (error) {
          /* ignore */
        }
        try {
          audio.removeAttribute('src')
          audio.load()
        } catch (error) {
          /* ignore */
        }
      }
      setState({ playingKey: null, busy: false, queueTotal: 0, queueDone: 0 })
    }

    function settings() {
      return store.state.settings || {}
    }

    function selection() {
      const s = settings()
      const overrides = {}
      if (s.edgeVoice) overrides.voice = s.edgeVoice
      if (s.rate) overrides.rate = s.rate
      if (Number.isFinite(Number(s.pitch))) overrides.pitch = Number(s.pitch)
      return overrides
    }

    // Edge only exposes rate / pitch / volume through SSML prosody, so a "tone"
    // here is a rate+pitch pair that audibly changes the delivery.
    const TONES = [
      { id: 'natural', zh: '自然', en: 'Natural', rate: 1.0, pitch: 0 },
      { id: 'gentle', zh: '温柔', en: 'Gentle', rate: 0.92, pitch: -8 },
      { id: 'serious', zh: '严肃', en: 'Serious', rate: 1.02, pitch: -14 },
      { id: 'lively', zh: '活泼', en: 'Lively', rate: 1.1, pitch: 14 },
      { id: 'low', zh: '低沉', en: 'Low', rate: 0.9, pitch: -24 },
    ]

    function toneLabel(tone) {
      return lang() === 'en' ? tone.en : tone.zh
    }

    function activeTone(s) {
      const rate = Number(s.rate || 1)
      const pitch = Number(s.pitch || 0)
      return TONES.find((tone) => Math.abs(tone.rate - rate) < 0.001 && Math.abs(tone.pitch - pitch) < 0.5) || null
    }

    async function playOne(payload, key) {
      const first = await api('/speak', Object.assign({}, payload, selection()))
      const el = audioEl()
      el.src = first.url
      el.muted = false
      setState({ playingKey: key, busy: false, error: null })
      try {
        await el.play()
        unlocked = true
      } catch (error) {
        if (autoplayBlocked(error)) {
          setState({ playingKey: null, busy: false, error: t('needTap') })
          return
        }
        throw error
      }
      return new Promise((resolve) => {
        const done = () => {
          el.removeEventListener('ended', done)
          el.removeEventListener('error', done)
          resolve()
        }
        el.addEventListener('ended', done)
        el.addEventListener('error', done)
      })
    }

    async function readMessage(messageId, sessionId) {
      const token = ++runToken
      setState({ busy: true, error: null, playingKey: messageId })
      try {
        await playOne({ messageId, sessionId }, messageId)
      } catch (error) {
        if (token === runToken) setState({ error: String(error.message || error) })
      } finally {
        if (token === runToken) setState({ playingKey: null, busy: false })
      }
    }

    async function readText(text, voiceOverride) {
      const token = ++runToken
      setState({ busy: true, error: null, playingKey: 'preview' })
      try {
        await playOne(voiceOverride ? { text, voice: voiceOverride } : { text }, 'preview')
      } catch (error) {
        if (token === runToken) setState({ error: String(error.message || error) })
      } finally {
        if (token === runToken) setState({ playingKey: null, busy: false })
      }
    }

    async function readSession(sessionId) {
      const token = ++runToken
      setState({ busy: true, error: null, queueTotal: 0, queueDone: 0 })
      try {
        const data = await api('/session-text?sessionId=' + encodeURIComponent(String(sessionId)))
        const segments = Array.isArray(data.segments) ? data.segments : []
        if (!segments.length) {
          setState({ error: t('sessionEmpty') })
          return
        }
        setState({ queueTotal: segments.length })
        for (let i = 0; i < segments.length; i++) {
          if (token !== runToken) return
          setState({ queueDone: i, playingKey: 'session' })
          await playOne({ text: segments[i] }, 'session')
        }
        if (token === runToken) setState({ queueDone: segments.length })
      } catch (error) {
        if (token === runToken) setState({ error: String(error.message || error) })
      } finally {
        if (token === runToken) setState({ playingKey: null, busy: false, queueTotal: 0, queueDone: 0 })
      }
    }

    // --------------------------------------------------------------- styles
    const S = {
      page: { display: 'flex', flexDirection: 'column', gap: '20px', padding: '4px 2px', color: 'var(--dsw-alias-label-primary)' },
      hint: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.5, margin: 0 },
      group: { display: 'flex', flexDirection: 'column', gap: '10px' },
      label: { fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      localeLabel: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', letterSpacing: '0.03em', textTransform: 'uppercase' },
      voices: { display: 'flex', flexWrap: 'wrap', gap: '8px' },
      voiceBtn: (active) => ({
        appearance: 'none',
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '8px 12px',
        borderRadius: '8px',
        fontSize: '13px',
        border: '1px solid ' + (active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)'),
        background: active ? 'var(--dsw-alias-bg-layer-2)' : 'var(--dsw-alias-bg-layer-1)',
        color: active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-primary)',
      }),
      badge: (female) => ({
        fontSize: '10px',
        lineHeight: 1,
        padding: '2px 5px',
        borderRadius: '4px',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: female ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
      }),
      row: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      btn: {
        appearance: 'none',
        cursor: 'pointer',
        padding: '7px 14px',
        borderRadius: '8px',
        fontSize: '13px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
      },
      primary: {
        appearance: 'none',
        cursor: 'pointer',
        padding: '7px 14px',
        borderRadius: '8px',
        fontSize: '13px',
        border: '1px solid var(--dsw-alias-brand-primary)',
        background: 'var(--dsw-alias-brand-primary)',
        color: '#fff',
      },
      toggle: (on) => ({
        appearance: 'none',
        cursor: 'pointer',
        padding: '7px 14px',
        borderRadius: '8px',
        fontSize: '13px',
        border: '1px solid ' + (on ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)'),
        background: on ? 'var(--dsw-alias-bg-layer-2)' : 'var(--dsw-alias-bg-layer-1)',
        color: on ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
      }),
      status: (kind) => ({
        fontSize: '12px',
        color: kind === 'error'
          ? 'var(--dsw-alias-state-error-primary)'
          : kind === 'ok'
            ? 'var(--dsw-alias-state-success-primary)'
            : 'var(--dsw-alias-label-secondary)',
      }),
      iconBtn: (active) => ({
        appearance: 'none',
        cursor: 'pointer',
        border: 'none',
        background: 'transparent',
        padding: '4px 6px',
        borderRadius: '6px',
        fontSize: '13px',
        lineHeight: 1,
        color: active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
      }),
    }

    // ------------------------------------------------------------ components
    function SpeakAction(props) {
      const state = useStore()
      const messageId = props && props.messageId ? String(props.messageId) : ''
      const sessionId = props && props.sessionId ? String(props.sessionId) : ''
      const active = state.playingKey === messageId
      const title = active ? t('stopReading') : t('readThis')
      return h(
        'button',
        {
          type: 'button',
          title,
          'aria-label': title,
          'aria-pressed': active,
          style: S.iconBtn(active),
          onClick: () => {
            if (active) stopAll()
            else readMessage(messageId, sessionId)
          },
        },
        active ? '⏸' : '▶',
      )
    }

    function DockBar(props) {
      const state = useStore()
      const sessionId = props && props.sessionId ? String(props.sessionId) : ''
      const s = state.settings || {}
      const playing = Boolean(state.playingKey)

      // Auto-read: poll the session's finished assistant replies and read only
      // the ones that appeared after the toggle was switched on.
      React.useEffect(() => {
        if (!s.autoRead || !sessionId) return undefined
        let cancelled = false
        let cursor = null
        const tick = async () => {
          if (cancelled) return
          if (store.state.playingKey) return
          if (!unlocked) return
          try {
            const data = await api('/session-text?sessionId=' + encodeURIComponent(sessionId))
            const segments = Array.isArray(data.segments) ? data.segments : []
            if (cursor === null) {
              cursor = segments.length
              return
            }
            if (segments.length <= cursor) {
              cursor = segments.length
              return
            }
            const fresh = segments.slice(cursor)
            cursor = segments.length
            const token = ++runToken
            for (const text of fresh) {
              if (cancelled || token !== runToken) return
              setState({ playingKey: 'auto', error: null })
              await playOne({ text }, 'auto')
            }
            if (!cancelled && token === runToken) setState({ playingKey: null })
          } catch (error) {
            /* session may not be loaded yet; keep polling */
          }
        }
        tick()
        const id = setInterval(tick, 2500)
        return () => {
          cancelled = true
          clearInterval(id)
        }
      }, [s.autoRead, sessionId])

      const label = state.error
        ? t('failed') + '：' + state.error
        : playing
          ? state.queueTotal > 0
            ? t('reading') + ' ' + (state.queueDone + 1) + '/' + state.queueTotal
            : t('reading')
          : t('idle')
      return h(
        'div',
        { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px 10px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', padding: '2px 4px' } },
        h(
          'button',
          {
            type: 'button',
            style: S.btn,
            disabled: !sessionId,
            onClick: () => (playing ? stopAll() : readSession(sessionId)),
          },
          playing ? '⏸ ' + t('stop') : '🔊 ' + t('readSession'),
        ),
        h('span', { style: S.status(state.error ? 'error' : playing ? 'ok' : 'idle') }, label),
        h(
          'button',
          {
            type: 'button',
            style: { appearance: 'none', border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '12px', color: s.autoRead ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)' },
            onClick: async () => {
              try {
                const data = await api('/settings', { autoRead: !s.autoRead })
                setState({ settings: data.settings })
              } catch (error) {
                setState({ error: String(error.message || error) })
              }
            },
          },
          (s.autoRead ? '✓ ' : '○ ') + t('autoRead'),
        ),
      )
    }

    function VoiceChip(props) {
      const voice = props.voice
      const active = props.active
      const female = String(voice.gender || '').toLowerCase() === 'female'
      return h(
        'button',
        {
          type: 'button',
          style: S.voiceBtn(active),
          title: voice.id,
          onClick: props.onClick,
        },
        h('span', null, voice.name || voice.nameEn || voice.id),
        h('span', { style: S.badge(female) }, female ? t('female') : t('male')),
        active ? h('span', { style: { fontSize: '11px' } }, '✓') : null,
      )
    }

    function SettingsPage() {
      const state = useStore()
      const s = state.settings || {}
      const voices = state.voices || []

      React.useEffect(() => {
        let alive = true
        ;(async () => {
          try {
            const data = await api('/settings')
            if (!alive) return
            setState({ settings: data.settings })
            const list = await api('/voices')
            if (!alive) return
            setState({ voices: list.voices || [] })
          } catch (error) {
            if (alive) setState({ error: String(error.message || error) })
          }
        })()
        return () => {
          alive = false
        }
      }, [])

      const pick = async (voice) => {
        setState({ settings: Object.assign({}, s, { edgeVoice: voice.id }) })
        try {
          const data = await api('/settings', { edgeVoice: voice.id })
          setState({ settings: data.settings, voices })
        } catch (error) {
          setState({ error: String(error.message || error) })
        }
        readText(t('sample'), voice.id)
      }

      const save = async (patch) => {
        try {
          const data = await api('/settings', patch)
          setState({ settings: data.settings })
        } catch (error) {
          setState({ error: String(error.message || error) })
        }
      }

      if (!s.edgeVoice && !voices.length) {
        return h('div', { style: S.page }, h('p', { style: S.hint }, t('loading')))
      }

      // Group by locale so 普通话 / 东北 / 陕西 / 粤语 / 台湾 一眼分开。
      const groups = new Map()
      for (const voice of voices) {
        const key = voice.locale || 'other'
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(voice)
      }
      return h(
        'div',
        { style: S.page },
        h('div', { style: S.group },
          h('div', { style: S.label }, t('settingsTitle')),
          h('p', { style: S.hint }, t('settingsHint')),
        ),
        h('div', { style: S.group },
          h('div', { style: S.label }, t('voice')),
          Array.from(groups.entries()).map(([locale, list]) =>
            h('div', { key: locale, style: S.group },
              h('div', { style: S.localeLabel }, (list[0] && list[0].localeLabel) || locale),
              h('div', { style: S.voices },
                list.map((voice) => h(VoiceChip, {
                  key: voice.id,
                  voice,
                  active: s.edgeVoice === voice.id,
                  onClick: () => pick(voice),
                })),
              ),
            )),
          !voices.length ? h('span', { style: S.hint }, t('noVoice')) : null,
        ),
        h('div', { style: S.group },
          h('div', { style: S.label }, t('tone')),
          h('div', { style: S.voices },
            TONES.map((tone) => {
              const on = (activeTone(s) || {}).id === tone.id
              return h('button', {
                key: tone.id,
                type: 'button',
                style: S.voiceBtn(on),
                onClick: () => save({ rate: tone.rate, pitch: tone.pitch }),
              }, toneLabel(tone))
            }),
          ),
          h('p', { style: S.hint }, t('toneHint')),
        ),
        h('div', { style: S.group },
          h('div', { style: S.label }, t('rate') + ' · ' + Number(s.rate || 1).toFixed(2) + '×'),
          h('input', {
            type: 'range',
            min: 0.6,
            max: 1.6,
            step: 0.05,
            value: Number(s.rate || 1),
            onChange: (event) => setState({ settings: Object.assign({}, s, { rate: Number(event.target.value) }) }),
            onMouseUp: (event) => save({ rate: Number(event.target.value) }),
            onTouchEnd: (event) => save({ rate: Number(event.target.value) }),
            style: { width: '100%', maxWidth: '340px' },
          }),
        ),
        h('div', { style: S.group },
          h('div', { style: S.label }, t('pitch') + ' · ' + (Number(s.pitch || 0) >= 0 ? '+' : '') + Number(s.pitch || 0) + 'Hz'),
          h('input', {
            type: 'range',
            min: -30,
            max: 30,
            step: 1,
            value: Number(s.pitch || 0),
            onChange: (event) => setState({ settings: Object.assign({}, s, { pitch: Number(event.target.value) }) }),
            onMouseUp: (event) => save({ pitch: Number(event.target.value) }),
            onTouchEnd: (event) => save({ pitch: Number(event.target.value) }),
            style: { width: '100%', maxWidth: '340px' },
          }),
        ),
        h('div', { style: S.row },
          h('button', { type: 'button', style: S.primary, onClick: () => readText(t('sample')) }, '▶ ' + t('preview')),
          h('button', { type: 'button', style: S.btn, onClick: stopAll }, '⏸ ' + t('stop')),
          h('button', { type: 'button', style: S.toggle(s.autoRead), onClick: () => save({ autoRead: !s.autoRead }) },
            (s.autoRead ? '✓ ' : '○ ') + t('autoRead')),
        ),
        h('div', { style: S.group },
          h('div', { style: S.label }, t('autoTone')),
          h('div', { style: S.row },
            h('button', { type: 'button', style: S.toggle(s.autoTone), onClick: () => save({ autoTone: !s.autoTone }) },
              (s.autoTone ? '✓ ' : '○ ') + (s.autoTone ? t('autoToneOn') : t('autoToneOff'))),
          ),
        ),
        state.error ? h('p', { style: S.status('error') }, state.error) : null,
      )
    }

    // ------------------------------------------------------------------ apply
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => {
          const disarm = armUnlock()
          let alive = true
          api('/settings')
            .then((data) => {
              if (!alive) return undefined
              setState({ settings: data.settings })
              return api('/voices')
            })
            .then((list) => {
              if (alive && list) setState({ voices: list.voices || [] })
            })
            .catch(() => {})
          return () => {
            alive = false
            disarm()
            stopAll()
          }
        })

        ctx.slots.inject('conversation.chat.assistant-actions', () =>
          ctx.slots.register(
            { name: 'conversation.chat.assistant-actions', id: SPEAK_ACTION_ID, order: 40 },
            SpeakAction,
          ))

        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            { name: 'conversation.composer.dock', id: DOCK_ID, order: 20 },
            DockBar,
          ))

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: SETTINGS_ID, order: 120, label: () => t('settingsTitle') },
            SettingsPage,
          ))
      },
    }
  },
})
