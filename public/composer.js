const root = document.querySelector('#wa-composer')
if (root instanceof HTMLElement) {
  const maxSeconds = Number(root.dataset.max || 30)
  const csrf = root.dataset.csrf || ''
  const accounts = JSON.parse(root.dataset.accounts || '[]')
  const tags = JSON.parse(root.dataset.tags || '[]')
  const colors = ['#0e6b52', '#075e54', '#128c7e', '#1f4b99', '#7a2e0e', '#111111', '#5b2c6f', '#c0392b']
  const fonts = [0, 1, 2]
  const fontNames = ['Обычный', 'С засечками', 'Рукописный']
  const fontFamilies = ['system-ui, sans-serif', 'Georgia, "Times New Roman", serif', '"Segoe Script", "Comic Sans MS", cursive']
  const emojis = ['😀', '🔥', '❤️', '✨', '👍', '😂', '🙏', '💚']
  const items = []
  let index = 0
  let audience = { mode: 'all', excludeTags: [], excludePhones: [], includeTags: [], includeSources: [], includePhones: [] }

  root.innerHTML = `
    <section id="screen-editor" class="composer" hidden>
      <button type="button" class="story-close" id="editor-back">Назад</button>
      <div id="editor-stage" class="story-card"></div>
      <div class="editor-tools">
        <label class="caption-field"><input id="caption" type="text" maxlength="1024" placeholder="Добавить подпись…"></label>
        <div id="trim-box" hidden>
          <label>Начало <input id="trim-start" type="range" min="0" max="30" step="0.1" value="0"></label>
          <label>Конец <input id="trim-end" type="range" min="0" max="30" step="0.1" value="30"></label>
          <p id="trim-label"></p>
          <button type="button" id="split-video" class="ghost" hidden>Разбить на статусы по ${maxSeconds} с</button>
          <label><input id="mute" type="checkbox"> Без звука</label>
        </div>
        <div class="row">
          <input id="overlay-text" type="text" maxlength="80" placeholder="Текст на кадре">
          <button type="button" id="add-overlay" class="ghost">На кадр</button>
        </div>
        <div class="emoji-row">${emojis.map((emoji) => `<button type="button" class="emoji" data-emoji="${emoji}">${emoji}</button>`).join('')}</div>
        <div id="thumbs" class="thumb-strip"></div>
        <button type="button" id="to-audience" class="send-next">Дальше</button>
      </div>
    </section>
    <section id="screen-text" class="composer" hidden>
      <button type="button" class="story-close" id="text-back">Назад</button>
      <button type="button" id="text-stage" class="story-card text-stage"><span id="text-body">Напишите статус</span></button>
      <p class="hint">Нажмите на фон, чтобы сменить цвет. Кнопка меняет шрифт.</p>
      <textarea id="text-input" maxlength="700" placeholder="Текст статуса"></textarea>
      <button type="button" id="font-cycle" class="ghost">Шрифт</button>
      <button type="button" id="text-next" class="send-next">Дальше</button>
    </section>
    <section id="screen-audience" class="composer" hidden>
      <button type="button" class="story-close" id="audience-back">Назад</button>
      <h2>Конфиденциальность статуса</h2>
      <label><input type="radio" name="aud" value="all" checked> Мои контакты</label>
      <label><input type="radio" name="aud" value="exclude"> Мои контакты, кроме…</label>
      <label><input type="radio" name="aud" value="only"> Только делиться с…</label>
      <p id="account-pick" hidden><label>Номер <select id="account-id"></select></label></p>
      <div id="aud-exclude" hidden>
        <p>Метки-исключения</p>
        <div id="exclude-tags"></div>
        <input id="exclude-search" type="search" placeholder="Найти контакт, чтобы исключить">
        <div id="exclude-results"></div>
        <div id="exclude-picked"></div>
      </div>
      <div id="aud-only" hidden>
        <p>Метки</p>
        <div id="include-tags"></div>
        <p>Источник</p>
        <label><input type="checkbox" value="whatsapp" class="src"> Чаты WhatsApp</label>
        <label><input type="checkbox" value="phone" class="src"> Телефонная книга</label>
        <input id="include-search" type="search" placeholder="Добавить контакт">
        <div id="include-results"></div>
        <div id="include-picked"></div>
      </div>
      <p id="aud-count">Считаем…</p>
      <button type="button" id="send-status" class="send-round" aria-label="Отправить">➤</button>
    </section>`

  const editor = root.querySelector('#screen-editor')
  const textScreen = root.querySelector('#screen-text')
  const audienceScreen = root.querySelector('#screen-audience')
  const show = (node) => {
    for (const screen of [editor, textScreen, audienceScreen]) {
      if (screen instanceof HTMLElement) screen.hidden = screen !== node
    }
  }

  const accountPick = root.querySelector('#account-id')
  const accountBox = root.querySelector('#account-pick')
  if (accountPick instanceof HTMLSelectElement && accounts.length > 1) {
    for (const account of accounts) {
      const option = document.createElement('option')
      option.value = account.id
      option.textContent = account.label
      accountPick.append(option)
    }
    if (accountBox instanceof HTMLElement) accountBox.hidden = false
  }

  document.querySelector('#add-status')?.addEventListener('click', () => document.querySelector('#media-files')?.click())
  document.querySelector('#add-text')?.addEventListener('click', () => {
    items.splice(0, items.length, { kind: 'text', text: '', color: colors[0], font: 0, overlays: [] })
    index = 0
    paintText()
    show(textScreen)
  })
  root.querySelector('#text-back')?.addEventListener('click', () => show(null))
  root.querySelector('#editor-back')?.addEventListener('click', () => show(null))
  root.querySelector('#audience-back')?.addEventListener('click', () => show(items[0]?.kind === 'text' ? textScreen : editor))

  document.querySelector('#media-files')?.addEventListener('change', async (event) => {
    const input = event.target
    if (!(input instanceof HTMLInputElement) || !input.files) return
    items.splice(0, items.length)
    for (const file of input.files) {
      const kind = file.type.startsWith('video') ? 'video' : 'image'
      const duration = kind === 'video' ? await videoDuration(file) : 0
      items.push({ kind, file, caption: '', mute: false, overlays: [], trimStart: 0, trimEnd: Math.min(duration || maxSeconds, maxSeconds), duration })
    }
    input.value = ''
    if (items.length === 0) return
    index = 0
    paintEditor()
    show(editor)
  })

  function paintEditor() {
    const item = items[index]
    const stage = root.querySelector('#editor-stage')
    if (!item || !(stage instanceof HTMLElement)) return
    for (const entry of items) {
      if (!entry.url && entry.file) entry.url = URL.createObjectURL(entry.file)
    }
    stage.innerHTML = ''
    const media = document.createElement(item.kind === 'video' ? 'video' : 'img')
    media.className = 'story-media'
    media.src = item.url
    if (media instanceof HTMLVideoElement) {
      media.muted = true
      media.playsInline = true
      media.onloadedmetadata = () => { media.currentTime = item.trimStart || 0 }
    }
    stage.append(media)
    for (const overlay of item.overlays || []) {
      const sticker = document.createElement('span')
      sticker.className = 'sticker'
      sticker.textContent = overlay.text
      sticker.style.left = `${overlay.x * 100}%`
      sticker.style.top = `${Math.min(overlay.y, 0.86) * 100}%`
      stage.append(sticker)
    }
    const caption = root.querySelector('#caption')
    if (caption instanceof HTMLInputElement) caption.value = item.caption || ''
    const trim = root.querySelector('#trim-box')
    if (trim instanceof HTMLElement) trim.hidden = item.kind !== 'video'
    if (item.kind === 'video') setupTrim(item)
    const strip = root.querySelector('#thumbs')
    if (strip instanceof HTMLElement) {
      strip.innerHTML = ''
      items.forEach((entry, entryIndex) => {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = entryIndex === index ? 'thumb on' : 'thumb'
        const preview = document.createElement(entry.kind === 'video' ? 'video' : 'img')
        preview.src = entry.url || ''
        if (preview instanceof HTMLVideoElement) preview.muted = true
        button.append(preview)
        button.addEventListener('click', () => { index = entryIndex; paintEditor() })
        const remove = document.createElement('button')
        remove.type = 'button'
        remove.className = 'remove-thumb'
        remove.textContent = '×'
        remove.addEventListener('click', (click) => {
          click.stopPropagation()
          if (entry.url) URL.revokeObjectURL(entry.url)
          items.splice(entryIndex, 1)
          index = Math.max(0, Math.min(index, items.length - 1))
          if (items.length === 0) show(null)
          else paintEditor()
        })
        const wrap = document.createElement('span')
        wrap.append(button, remove)
        strip.append(wrap)
      })
    }
  }

  function setupTrim(item) {
    const start = root.querySelector('#trim-start')
    const end = root.querySelector('#trim-end')
    const label = root.querySelector('#trim-label')
    const split = root.querySelector('#split-video')
    if (!(start instanceof HTMLInputElement) || !(end instanceof HTMLInputElement)) return
    const duration = item.duration || maxSeconds
    start.max = String(duration)
    end.max = String(duration)
    start.value = String(item.trimStart || 0)
    end.value = String(item.trimEnd || Math.min(duration, maxSeconds))
    const sync = () => {
      let a = Number(start.value)
      let b = Number(end.value)
      if (b < a + 0.2) b = Math.min(duration, a + 0.2)
      if (b - a > maxSeconds) b = a + maxSeconds
      item.trimStart = a
      item.trimEnd = b
      end.value = String(b)
      if (label) label.textContent = `${a.toFixed(1)}–${b.toFixed(1)} с, не длиннее ${maxSeconds} с`
    }
    start.oninput = sync
    end.oninput = sync
    sync()
    if (split instanceof HTMLButtonElement) {
      split.hidden = duration <= maxSeconds + 0.2
      split.onclick = () => {
        const parts = []
        for (let cursor = 0; cursor < duration - 0.05; cursor += maxSeconds) {
          parts.push({ ...item, overlays: [...item.overlays], trimStart: cursor, trimEnd: Math.min(duration, cursor + maxSeconds), caption: item.caption })
        }
        items.splice(index, 1, ...parts)
        paintEditor()
      }
    }
    const mute = root.querySelector('#mute')
    if (mute instanceof HTMLInputElement) {
      mute.checked = Boolean(item.mute)
      mute.onchange = () => { item.mute = mute.checked }
    }
  }

  root.querySelector('#caption')?.addEventListener('input', (event) => {
    const item = items[index]
    if (item && event.target instanceof HTMLInputElement) item.caption = event.target.value
  })
  root.querySelector('#add-overlay')?.addEventListener('click', () => {
    const field = root.querySelector('#overlay-text')
    const item = items[index]
    if (!item || !(field instanceof HTMLInputElement) || !field.value.trim()) return
    if (item.overlays.length >= 8) return
    item.overlays.push({ text: field.value.trim(), x: 0.5, y: 0.35 + item.overlays.length * 0.12 })
    field.value = ''
    paintEditor()
  })
  root.querySelectorAll('[data-emoji]').forEach((button) => {
    button.addEventListener('click', () => {
      const item = items[index]
      if (!item) return
      if (item.overlays.length >= 8) return
      item.overlays.push({ text: button.getAttribute('data-emoji') || '', x: 0.5, y: 0.2 + item.overlays.length * 0.1 })
      paintEditor()
    })
  })
  root.querySelector('#to-audience')?.addEventListener('click', () => { show(audienceScreen); void refreshCount() })

  let textItem = null
  function paintText() {
    textItem = items[0]
    const stage = root.querySelector('#text-stage')
    const body = root.querySelector('#text-body')
    const input = root.querySelector('#text-input')
    if (stage instanceof HTMLElement && textItem) stage.style.background = textItem.color
    if (body instanceof HTMLElement) {
      body.textContent = textItem?.text || 'Напишите статус'
      body.style.fontFamily = fontFamilies[textItem?.font ?? 0] || fontFamilies[0]
    }
    const fontButton = root.querySelector('#font-cycle')
    if (fontButton) fontButton.textContent = `Шрифт: ${fontNames[textItem?.font ?? 0] || fontNames[0]}`
    if (input instanceof HTMLTextAreaElement && textItem && input.value !== textItem.text) input.value = textItem.text
  }
  root.querySelector('#text-stage')?.addEventListener('click', () => {
    if (!textItem) return
    const at = colors.indexOf(textItem.color)
    textItem.color = colors[(at + 1) % colors.length]
    paintText()
  })
  root.querySelector('#font-cycle')?.addEventListener('click', () => {
    if (!textItem) return
    const at = fonts.indexOf(textItem.font)
    textItem.font = fonts[(at + 1) % fonts.length]
    paintText()
  })
  root.querySelector('#text-input')?.addEventListener('input', (event) => {
    if (textItem && event.target instanceof HTMLTextAreaElement) textItem.text = event.target.value
    const body = root.querySelector('#text-body')
    if (body) body.textContent = textItem?.text || 'Напишите статус'
  })
  root.querySelector('#text-next')?.addEventListener('click', () => { show(audienceScreen); void refreshCount() })

  const tagBox = (id, key) => {
    const box = root.querySelector(id)
    if (!(box instanceof HTMLElement)) return
    for (const tag of tags) {
      const label = document.createElement('label')
      const input = document.createElement('input')
      input.type = 'checkbox'
      input.value = tag
      label.append(input, document.createTextNode(' ' + tag))
      box.append(label)
    }
    box.addEventListener('change', () => {
      audience[key] = [...box.querySelectorAll('input:checked')].map((input) => input instanceof HTMLInputElement ? input.value : '')
      void refreshCount()
    })
  }
  tagBox('#exclude-tags', 'excludeTags')
  tagBox('#include-tags', 'includeTags')
  root.querySelectorAll('input[name="aud"]').forEach((input) => {
    input.addEventListener('change', () => {
      if (!(input instanceof HTMLInputElement) || !input.checked) return
      audience.mode = input.value
      const exclude = root.querySelector('#aud-exclude')
      const only = root.querySelector('#aud-only')
      if (exclude instanceof HTMLElement) exclude.hidden = input.value !== 'exclude'
      if (only instanceof HTMLElement) only.hidden = input.value !== 'only'
      void refreshCount()
    })
  })
  root.querySelectorAll('.src').forEach((input) => {
    input.addEventListener('change', () => {
      audience.includeSources = [...root.querySelectorAll('.src:checked')].map((node) => node instanceof HTMLInputElement ? node.value : '')
      void refreshCount()
    })
  })
  wireSearch('#exclude-search', '#exclude-results', '#exclude-picked', 'excludePhones')
  wireSearch('#include-search', '#include-results', '#include-picked', 'includePhones')

  function wireSearch(fieldId, resultsId, pickedId, key) {
    const field = root.querySelector(fieldId)
    const results = root.querySelector(resultsId)
    const picked = root.querySelector(pickedId)
    if (!(field instanceof HTMLInputElement) || !(results instanceof HTMLElement) || !(picked instanceof HTMLElement)) return
    let timer = 0
    field.addEventListener('input', () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(async () => {
        const response = await fetch(`/api/contacts?q=${encodeURIComponent(field.value)}`)
        const data = await response.json()
        results.innerHTML = ''
        for (const contact of data.items || []) {
          const button = document.createElement('button')
          button.type = 'button'
          button.className = 'ghost'
          button.textContent = `${contact.name || 'Без имени'} ${contact.phone}`
          button.addEventListener('click', () => {
            if (!audience[key].includes(contact.phone)) audience[key].push(contact.phone)
            paintPicked()
            void refreshCount()
          })
          results.append(button)
        }
      }, 250)
    })
    function paintPicked() {
      picked.innerHTML = ''
      for (const phone of audience[key]) {
        const chip = document.createElement('button')
        chip.type = 'button'
        chip.textContent = `${phone} ×`
        chip.addEventListener('click', () => {
          audience[key] = audience[key].filter((item) => item !== phone)
          paintPicked()
          void refreshCount()
        })
        picked.append(chip)
      }
    }
  }

  async function refreshCount() {
    const box = root.querySelector('#aud-count')
    try {
      const body = new URLSearchParams({ csrf, audience: JSON.stringify(audience) })
      const response = await fetch('/api/audience-count', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })
      const data = await response.json()
      if (box) box.textContent = `Получателей: ${data.count ?? 0}. Ваш номер добавится отдельно, чтобы статус был виден вам.`
    } catch {
      if (box) box.textContent = 'Не удалось посчитать получателей'
    }
  }

  root.querySelector('#send-status')?.addEventListener('click', async () => {
    const picked = root.querySelector('#account-id')
    const accountId = picked instanceof HTMLSelectElement && picked.value ? picked.value : accounts[0]?.id
    if (!accountId) { window.alert('Сначала подключите номер'); return }
    const form = new FormData()
    form.set('csrf', csrf)
    form.set('account_id', accountId)
    form.set('audience', JSON.stringify(audience))
    const files = []
    const payload = items.map((item) => {
      if (item.kind === 'text') return { kind: 'text', text: item.text, color: item.color, font: item.font }
      let fileIndex = files.indexOf(item.file)
      if (fileIndex < 0) { files.push(item.file); fileIndex = files.length - 1 }
      return {
        kind: item.kind, caption: item.caption, fileIndex, trimStart: item.trimStart, trimEnd: item.trimEnd,
        mute: item.mute, overlays: item.overlays,
      }
    })
    form.set('items', JSON.stringify(payload))
    for (const file of files) form.append('files', file)
    const button = root.querySelector('#send-status')
    if (button instanceof HTMLButtonElement) button.disabled = true
    const ring = startRing()
    show(null)
    try {
      const response = await fetch('/stories/compose', { method: 'POST', body: form })
      const data = await response.json()
      if (!response.ok) {
        ring.remove()
        window.alert(data.error || 'Не отправилось')
        if (button instanceof HTMLButtonElement) button.disabled = false
        show(audienceScreen)
        return
      }
      window.location.href = '/stories'
    } catch {
      ring.remove()
      window.alert('Сеть недоступна')
      if (button instanceof HTMLButtonElement) button.disabled = false
      show(audienceScreen)
    }
  })

  function startRing() {
    const row = document.querySelector('.story-row')
    const ring = document.createElement('div')
    ring.className = 'story-ring'
    ring.innerHTML = '<span class="ring-face progress"></span><small>отправка</small>'
    row?.prepend(ring)
    return ring
  }

}

function videoDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.onloadedmetadata = () => { resolve(video.duration || 0); URL.revokeObjectURL(url) }
    video.onerror = () => resolve(0)
    video.src = url
  })
}
