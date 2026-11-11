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
        image.src = data.qrDataUrl
        image.classList.remove('hidden')
      } else image.classList.add('hidden')
    }
    if (data.status === 'connected' && qrRoot.dataset.status !== 'connected') {
      window.location.reload()
      return
    }
    qrRoot.dataset.status = data.status
  }
  const tick = async () => {
    try {
      const response = await fetch(qrRoot.dataset.url || '', { headers: { Accept: 'application/json' } })
      if (response.ok) paint(await response.json())
    } catch {
      /* следующая попытка */
    }
    window.setTimeout(tick, 2000)
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
  statusForm.addEventListener('change', () => {
    showKind()
    showWhen()
    void refreshCount()
  })
  statusForm.addEventListener('input', () => { void refreshCount() })
  showKind()
  showWhen()
  void refreshCount()
}
