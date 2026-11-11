document.addEventListener('submit', (event) => {
  const form = event.target
  if (!(form instanceof HTMLFormElement)) return
  const message = form.dataset.confirm
  if (message && !window.confirm(message)) event.preventDefault()
})

const qrRoot = document.querySelector('#qr-root')
if (qrRoot instanceof HTMLElement) {
  const paint = (data) => {
    const status = document.querySelector('#acc-status')
    const phone = document.querySelector('#acc-phone')
    const error = document.querySelector('#acc-error')
    const discovered = document.querySelector('#acc-discovered')
    const image = document.querySelector('#qr-image')
    if (status) status.textContent = data.statusLabel
    if (phone) phone.textContent = data.phoneDisplay || ''
    if (error) error.textContent = data.error || ''
    if (discovered) discovered.textContent = `В кэше WhatsApp: ${data.discovered}`
    if (image instanceof HTMLImageElement) {
      if (data.qrDataUrl) {
        if (image.dataset.qr !== data.qrDataUrl) {
          image.src = data.qrDataUrl
          image.dataset.qr = data.qrDataUrl
        }
        image.classList.remove('hidden')
      } else if (data.status !== 'qr') {
        image.classList.add('hidden')
      }
    }
    if (data.status === 'connected' && qrRoot.dataset.status !== 'connected') {
      window.location.reload()
      return
    }
    qrRoot.dataset.status = data.status
  }
  let pending = false
  const tick = async () => {
    if (pending) {
      window.setTimeout(tick, 2000)
      return
    }
    pending = true
    try {
      const response = await fetch(qrRoot.dataset.url || '', {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        signal: AbortSignal.timeout(4000),
      })
      if (response.ok) paint(await response.json())
    } catch {
      /* следующая попытка, панель не ждёт зависший опрос */
    } finally {
      pending = false
      window.setTimeout(tick, 2000)
    }
  }
  tick()
}

const progressRoot = document.querySelector('#progress-root')
if (progressRoot instanceof HTMLElement && progressRoot.dataset.finished !== '1') {
  const tick = async () => {
    try {
      const response = await fetch(progressRoot.dataset.url || '', { headers: { Accept: 'application/json' } })
      if (response.ok) {
        const data = await response.json()
        const label = document.querySelector('#progress-label')
        const counts = document.querySelector('#progress-counts')
        const fill = document.querySelector('#progress-fill')
        if (label) label.textContent = data.statusLabel
        if (counts) {
          counts.textContent = `${data.successRecipients} из ${data.totalRecipients}, пачек ${data.sentBatches} из ${data.totalBatches}`
        }
        if (fill instanceof HTMLElement) fill.style.width = `${data.percent}%`
        if (data.finished) window.location.reload()
      }
    } catch {
      /* следующая попытка */
    }
    window.setTimeout(tick, 2000)
  }
  tick()
}

const statusForm = document.querySelector('#status-form')
if (statusForm instanceof HTMLFormElement) {
  const showKind = () => {
    const kind = statusForm.querySelector('input[name="kind"]:checked')
    const value = kind instanceof HTMLInputElement ? kind.value : 'text'
    statusForm.querySelectorAll('[data-kind]').forEach((node) => {
      if (node instanceof HTMLElement) node.classList.toggle('hidden', node.dataset.kind !== value)
    })
  }
  const showWhen = () => {
    const when = statusForm.querySelector('input[name="when"]:checked')
    const schedule = document.querySelector('#schedule-field')
    const value = when instanceof HTMLInputElement ? when.value : 'now'
    if (schedule instanceof HTMLElement) schedule.classList.toggle('hidden', value !== 'schedule')
  }
  const refreshCount = async () => {
    const source = statusForm.querySelector('input[name="audience_source"]:checked')
    const tagInput = statusForm.querySelector('input[name="tag"]')
    const sourceValue = source instanceof HTMLInputElement ? source.value : 'any'
    const tag = tagInput instanceof HTMLInputElement ? tagInput.value : ''
    const box = document.querySelector('#audience-count')
    try {
      const url = `/api/audience?source=${encodeURIComponent(sourceValue)}&tag=${encodeURIComponent(tag)}`
      const response = await fetch(url, { headers: { Accept: 'application/json' } })
      if (!response.ok || !(box instanceof HTMLElement)) return
      const data = await response.json()
      const batchSize = Number(statusForm.dataset.batchSize || 100)
      const delay = Number(statusForm.dataset.batchDelay || 4000)
      const batches = data.count > 0 ? Math.ceil(data.count / batchSize) : 0
      const pause = Math.max(0, batches - 1) * delay
      const minutes = Math.round(pause / 60000)
      box.textContent = `Получателей: ${data.count}. Пачек: ${batches}. Паузы между пачками около ${minutes} мин.`
    } catch {
      if (box instanceof HTMLElement) box.textContent = 'Не удалось посчитать аудиторию'
    }
  }
  const preview = document.querySelector('#story-preview')
  const paintPreview = () => {
    if (!(preview instanceof HTMLElement)) return
    const kind = statusForm.querySelector('input[name="kind"]:checked')
    const value = kind instanceof HTMLInputElement ? kind.value : 'text'
    const text = statusForm.querySelector('textarea[name="text"]')
    const caption = statusForm.querySelector('input[name="caption"]')
    const color = statusForm.querySelector('input[name="background_color"]')
    const fileInput = statusForm.querySelector(value === 'video' ? 'input[name="video"]' : 'input[name="image"]')
    const file = fileInput instanceof HTMLInputElement ? fileInput.files?.[0] : undefined
    const captionText = caption instanceof HTMLInputElement ? caption.value : ''
    if (value === 'text') {
      const body = text instanceof HTMLTextAreaElement ? text.value : ''
      const bg = color instanceof HTMLInputElement ? color.value : '#0e6b52'
      preview.style.background = bg
      preview.innerHTML = `<div class="story-text"></div>`
      const node = preview.querySelector('.story-text')
      if (node) node.textContent = body || 'Текст статуса'
      return
    }
    preview.style.background = '#111'
    preview.innerHTML = ''
    if (!file) {
      preview.textContent = 'Выберите файл, чтобы увидеть предпросмотр'
      return
    }
    const url = URL.createObjectURL(file)
    const media = document.createElement(value === 'video' ? 'video' : 'img')
    media.className = 'story-media'
    media.src = url
    if (media instanceof HTMLVideoElement) { media.muted = true; media.controls = true; media.playsInline = true }
    preview.append(media)
    const copy = document.createElement('div')
    copy.className = 'story-copy'
    copy.textContent = captionText
    preview.append(copy)
  }
  statusForm.addEventListener('change', () => { showKind(); showWhen(); paintPreview(); void refreshCount() })
  statusForm.addEventListener('input', () => { paintPreview(); void refreshCount() })
  showKind()
  showWhen()
  paintPreview()
  void refreshCount()
}

const cooldown = document.querySelector('#publish-cooldown')
if (cooldown instanceof HTMLElement) {
  const tick = async () => {
    let until = cooldown.dataset.until ? Date.parse(cooldown.dataset.until) : 0
    if (!until) {
      try {
        const response = await fetch('/api/cooldown', { cache: 'no-store', signal: AbortSignal.timeout(4000) })
        if (response.ok) {
          const data = await response.json()
          until = data.until ? Date.parse(data.until) : 0
          if (data.running) cooldown.textContent = 'Сейчас уже идёт публикация. Новая встанет в очередь.'
        }
      } catch { /* тихий повтор */ }
    }
    const left = until ? Math.max(0, until - Date.now()) : 0
    if (left > 0) {
      const seconds = Math.ceil(left / 1000)
      const minutes = Math.floor(seconds / 60)
      cooldown.hidden = false
      cooldown.textContent = `Следующую публикацию можно отправить через ${minutes}:${String(seconds % 60).padStart(2, '0')}`
    } else if (!cooldown.textContent?.includes('идёт публикация')) {
      cooldown.hidden = true
    }
    window.setTimeout(tick, 1000)
  }
  void tick()
}

const storyDataNode = document.querySelector('#story-data')
const stage = document.querySelector('#story-stage')
const card = document.querySelector('#story-card')
if (storyDataNode && stage instanceof HTMLElement && card instanceof HTMLElement) {
  const stories = JSON.parse(storyDataNode.textContent || '[]')
  const byId = new Map(stories.map((story) => [String(story.id), story]))
  const close = () => { stage.hidden = true; stage.classList.add('hidden'); card.innerHTML = '' }
  const open = (id) => {
    const story = byId.get(String(id))
    if (!story) return
    card.innerHTML = ''
    card.style.background = story.color || '#0b141a'
    if (story.kind === 'text') {
      const text = document.createElement('div')
      text.className = 'story-text'
      text.textContent = story.text
      card.append(text)
    } else if (story.mediaUrl) {
      const media = document.createElement(story.kind === 'video' ? 'video' : 'img')
      media.className = 'story-media'
      media.src = story.mediaUrl
      if (media instanceof HTMLVideoElement) { media.controls = true; media.autoplay = true; media.playsInline = true }
      card.append(media)
    }
    const copy = document.createElement('div')
    copy.className = 'story-copy'
    const title = document.createElement('h3')
    title.textContent = story.label
    const meta = document.createElement('p')
    const expires = story.expires ? Date.parse(story.expires) : 0
    const left = expires ? Math.max(0, expires - Date.now()) : 0
    const hours = Math.floor(left / 3600000)
    const minutes = Math.floor((left % 3600000) / 60000)
    meta.textContent = `${story.posted}. ${left > 0 ? `Исчезнет через ${hours} ч ${minutes} мин` : '24 часа прошли'}. 👁 ${story.views}`
    const link = document.createElement('a')
    link.href = `/status/${story.id}/viewers`
    link.textContent = 'Кто смотрел'
    link.style.color = 'white'
    copy.append(title, meta, link)
    if (story.caption) {
      const caption = document.createElement('p')
      caption.textContent = story.caption
      copy.append(caption)
    }
    card.append(copy)
    stage.hidden = false
    stage.classList.remove('hidden')
  }
  document.querySelectorAll('[data-open-story]').forEach((node) => {
    node.addEventListener('click', () => open(node.getAttribute('data-open-story')))
  })
  document.querySelector('#story-close')?.addEventListener('click', close)
  stage.addEventListener('click', (event) => { if (event.target === stage) close() })
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') close() })
}
