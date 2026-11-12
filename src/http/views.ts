import { formatRuPhone } from '../phone.js'
import {
  ACCOUNT_STATUS_RU,
  AUDIENCE_RU,
  BATCH_STATUS_RU,
  KIND_RU,
  POST_STATUS_RU,
  SOURCE_FILTER_RU,
} from '../labels.js'
import type {
  Account,
  AccountStatus,
  Contact,
  ImportRun,
  PostStatus,
  SourceFilter,
  StatusBatch,
  StatusPost,
} from '../types.js'
import { statusExpiresAt } from '../statusLogic.js'
import { formatMoscow } from '../time.js'

export function esc(value: string | number | null | undefined): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const NAV = [
  ['home', '/', 'Обзор'],
  ['accounts', '/accounts', 'Номера'],
  ['contacts', '/contacts', 'Контакты'],
  ['stories', '/stories', 'Мои статусы'],
  ['status', '/status', 'Публикации'],
  ['health', '/health', 'Журнал'],
] as const

export function layout(opts: {
  title: string
  active: string
  body: string
  warnings?: string[]
  flash?: string
}): string {
  const nav = NAV.map(([id, href, label]) => `<a class="${opts.active === id ? 'active' : ''}" href="${href}">${label}</a>`).join('')
  const warnings = (opts.warnings ?? []).map((item) => `<div class="flash bad">${esc(item)}</div>`).join('')
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>${esc(opts.title)} — WA Status Pro</title>
  <link rel="stylesheet" href="/assets/app.css">
</head>
<body>
  <div class="shell">
    <aside class="side">
      <div class="brand"><div class="mark">WA</div><div><strong>Status Pro</strong><small>своя панель статусов</small></div></div>
      <nav>${nav}</nav>
    </aside>
    <main class="main">
      ${warnings}
      ${opts.flash ?? ''}
      ${opts.body}
      <p class="footer-note">Неофициальный клиент WhatsApp Web. Номер могут ограничить — сначала проверяйте на запасной SIM.</p>
    </main>
  </div>
  <script src="/assets/app.js"></script>
</body>
</html>`
}

export function loginPage(opts: { error?: string; next?: string }): string {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Вход — WA Status Pro</title>
  <link rel="stylesheet" href="/assets/app.css">
</head>
<body>
  <div class="login">
    <form class="panel" method="post" action="/login">
      <h1>Вход</h1>
      <p class="lead">Панель публикации статусов WhatsApp. Пароль задаётся в ADMIN_PASSWORD.</p>
      ${opts.error ? `<div class="flash bad">${esc(opts.error)}</div>` : ''}
      <input type="hidden" name="next" value="${esc(opts.next || '/')}">
      <p><label><span>Пароль</span><input type="password" name="password" autofocus required></label></p>
      <button type="submit">Войти</button>
    </form>
  </div>
</body>
</html>`
}

export function renderFlash(query: Record<string, unknown>): string {
  const msg = q(query.msg)
  if (!msg) return ''
  const added = num(query.added)
  const updated = num(query.updated)
  const skipped = num(query.skipped)
  const merged = num(query.merged)
  const run = num(query.run)
  const unchanged = num(query.unchanged)
  const discovered = num(query.discovered)
  const texts: Record<string, [string, string]> = {
    saved: ['ok', 'Сохранено.'],
    deleted: ['ok', 'Удалено.'],
    queued: ['ok', 'Публикация поставлена в очередь.'],
    delete_queued: ['ok', 'Удаление поставлено в очередь. У тех, кому статус ещё не истёк, он пропадёт.'],
    scheduled: ['ok', 'Публикация запланирована по московскому времени.'],
    cancelled: ['ok', 'Публикация остановлена.'],
    bad_password: ['bad', 'Неверный пароль.'],
    rate_limited: ['bad', 'Слишком много попыток входа. Подождите 15 минут.'],
    csrf: ['bad', 'Сессия устарела. Обновите страницу и повторите.'],
    sync_empty: ['bad', 'WhatsApp ещё не передал контакты. Подождите минуту после QR и повторите. Полная телефонная книга так не приходит — для неё загрузите VCF.'],
    sync_offline: ['bad', 'Номер не подключён, и кэш контактов пуст.'],
    file_required: ['bad', 'Выберите файл контактов.'],
    file_type: ['bad', 'Нужен файл CSV, TXT, XLSX или VCF.'],
    file_large: ['bad', 'Файл больше допустимого размера.'],
    text_required: ['bad', 'Напишите текст статуса.'],
    text_long: ['bad', 'Текст длиннее 700 символов.'],
    caption_long: ['bad', 'Подпись длиннее 1024 символов.'],
    bad_time: ['bad', 'Не разобрали дату. Укажите московское время.'],
    past_time: ['bad', 'Это время уже прошло.'],
    no_account: ['bad', 'Выберите подключённый номер.'],
    no_recipients: ['bad', 'В выбранной аудитории нет контактов.'],
    ffmpeg: ['bad', 'Не удалось подготовить файл. Подробности в журнале.'],
    logged_out_ok: ['ok', 'Устройство отвязано.'],
    label_saved: ['ok', 'Название сохранено.'],
    tags_saved: ['ok', 'Метки сохранены.'],
    contact_deleted: ['ok', 'Контакт удалён.'],
    not_found: ['bad', 'Запись не найдена.'],
    format: ['bad', 'Не разобрали файл. Нужен столбец телефона или карточки VCF.'],
    reconnecting: ['ok', 'Запросили новое подключение.'],
  }
  if (msg === 'imported') {
    return `<div class="flash ok">Импорт из телефонной книги: добавлено ${added}, обновлено ${updated}, пропущено ${skipped}, дублей в файле ${merged}. <a href="/contacts/imports/${run}">Строки с ошибками</a></div>`
  }
  if (msg === 'synced') {
    return `<div class="flash ok">Синхронизация WhatsApp: в кэше ${discovered}, добавлено ${added}, обновлено ${updated}, без изменений ${unchanged}.</div>`
  }
  const known = texts[msg]
  if (!known) return ''
  return `<div class="flash ${known[0]}">${known[1]}</div>`
}

function q(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
function num(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function badge(status: string, label: string): string {
  const kind = status === 'connected' || status === 'done' || status === 'sent' ? 'ok'
    : status === 'failed' || status === 'error' || status === 'logged_out' ? 'bad'
      : 'warn'
  return `<span class="badge ${kind}">${esc(label)}</span>`
}

export function dashboardPage(input: {
  accounts: Account[]
  contacts: number
  sources: { whatsapp: number; phone: number; both: number }
  queue: { queued: number; scheduled: number; running: number }
  today: number
  posts: StatusPost[]
}): string {
  const cards = [
    ['Номера', String(input.accounts.length)],
    ['Контакты', String(input.contacts)],
    ['Из WhatsApp', String(input.sources.whatsapp)],
    ['Из телефона', String(input.sources.phone)],
    ['В обоих', String(input.sources.both)],
    ['Сегодня', String(input.today)],
  ].map(([label, value]) => `<div class="card"><span class="muted">${label}</span><b>${value}</b></div>`).join('')
  const rows = input.posts.slice(0, 6).map((post) => `<tr>
    <td><a href="/status/${post.id}">#${post.id}</a></td>
    <td>${esc(KIND_RU[post.kind])}</td>
    <td>${esc(AUDIENCE_RU[post.audienceSource])}</td>
    <td>${badge(post.status, POST_STATUS_RU[post.status])}</td>
    <td>${esc(formatMoscow(post.scheduledAt || post.createdAt))}</td>
  </tr>`).join('')
  return `<h1>Обзор</h1>
  <p class="lead">Статусы уходят со своего сервера на аудиторию, которая хранится здесь, а не в раздутой телефонной книге.</p>
  <div class="grid">${cards}</div>
  <p class="muted">В очереди: ${input.queue.queued}, запланировано: ${input.queue.scheduled}, публикуется: ${input.queue.running}.</p>
  <div class="panel"><h2>Последние публикации</h2>
    ${rows ? `<table><tr><th></th><th>Тип</th><th>Аудитория</th><th>Статус</th><th>Когда</th></tr>${rows}</table>` : '<p>Пока пусто.</p>'}
  </div>`
}

export function accountsPage(accounts: Account[], csrf: string): string {
  const rows = accounts.map((account) => `<tr>
    <td><a href="/accounts/${esc(account.id)}">${esc(account.label)}</a></td>
    <td>${esc(account.phone ? formatRuPhone(account.phone) : '—')}</td>
    <td>${badge(account.status, ACCOUNT_STATUS_RU[account.status])}</td>
    <td>${esc(account.lastError || '')}</td>
  </tr>`).join('')
  return `<h1>Номера</h1>
  <p class="lead">Каждый номер подключается как связанное устройство WhatsApp. Сессия сохраняется на диске и поднимается после перезапуска.</p>
  <form class="panel row" method="post" action="/accounts">
    <input type="hidden" name="csrf" value="${esc(csrf)}">
    <label><span>Название</span><input name="label" required maxlength="40" placeholder="Основной блог"></label>
    <button type="submit">Добавить номер</button>
  </form>
  <div class="panel">
    ${rows ? `<table><tr><th>Название</th><th>Телефон</th><th>Состояние</th><th>Сообщение</th></tr>${rows}</table>` : '<p>Номеров ещё нет.</p>'}
  </div>`
}

export function accountPage(account: Account, csrf: string, discovered: number, proxyLabel: string | null): string {
  const qr = account.status === 'connected' ? '' : `<img id="qr-image" class="qr hidden" alt="QR-код для привязки WhatsApp" decoding="async">`
  return `<h1>${esc(account.label)}</h1>
  <div id="qr-root" data-url="/accounts/${esc(account.id)}/state" data-status="${esc(account.status)}">
    <p id="acc-status">${badge(account.status, ACCOUNT_STATUS_RU[account.status])}</p>
    <p id="acc-phone">${esc(account.phone ? formatRuPhone(account.phone) : '')}</p>
    <p id="acc-error" class="muted">${esc(account.lastError || '')}</p>
    <p id="acc-discovered">В кэше WhatsApp: ${discovered}. ${account.historyComplete ? 'История чатов получена.' : 'История чатов может ещё догружаться.'}</p>
    ${qr}
    <p id="qr-hint" class="hint">Код на экране остаётся, пока готовится следующий. Страница не перезагружается.</p>
  </div>
  <div class="panel">
    <h2>Как привязать</h2>
    <ol>
      <li>На телефоне откройте WhatsApp → Связанные устройства → Привязка устройства.</li>
      <li>Сканируйте QR с этой страницы. Картинка обновляется сама.</li>
      <li>В списке устройств появится WA Status Pro.</li>
    </ol>
    <p class="hint">На своём телефоне статус, отправленный отсюда, может висеть с пометкой «ожидание». У получателей он открывается обычным образом.</p>
    <p class="hint">${proxyLabel ? `Сокет и медиа WhatsApp идут через ${esc(proxyLabel)}. Страницы панели открываются напрямую.` : 'Прокси не задан: WhatsApp подключается с этого сервера напрямую.'}</p>
  </div>
  <div class="panel">
    <h2>Контакты из WhatsApp</h2>
    <p>Кнопка забирает в общую базу тех, кого WhatsApp уже отдал после привязки: переписки и контакты аккаунта. Запись получает источник «WhatsApp» и не стирает источник «Телефон», если номер уже был загружен файлом.</p>
    <p class="hint">Люди из телефонной книги, с которыми не было переписки и которых WhatsApp не синхронизировал в аккаунт, в этот список не попадают. Для полной книги загрузите VCF, CSV или XLSX — такие номера получат источник «Телефон».</p>
    <form method="post" action="/accounts/${esc(account.id)}/sync">
      <input type="hidden" name="csrf" value="${esc(csrf)}">
      <button type="submit">Синхронизировать контакты из WhatsApp</button>
    </form>
  </div>
  <div class="row">
    <form method="post" action="/accounts/${esc(account.id)}/label" class="row">
      <input type="hidden" name="csrf" value="${esc(csrf)}">
      <label><span>Название</span><input name="label" value="${esc(account.label)}" maxlength="40" required></label>
      <button class="ghost" type="submit">Сохранить</button>
    </form>
    <form method="post" action="/accounts/${esc(account.id)}/reconnect">
      <input type="hidden" name="csrf" value="${esc(csrf)}">
      <button class="ghost" type="submit">Подключить снова</button>
    </form>
    <form method="post" action="/accounts/${esc(account.id)}/logout" data-confirm="Отвязать это устройство в WhatsApp?">
      <input type="hidden" name="csrf" value="${esc(csrf)}">
      <button class="ghost" type="submit">Отвязать</button>
    </form>
    <form method="post" action="/accounts/${esc(account.id)}/delete" data-confirm="Удалить номер из панели и отвязать сессию?">
      <input type="hidden" name="csrf" value="${esc(csrf)}">
      <button class="danger" type="submit">Удалить</button>
    </form>
  </div>`
}

export function contactsPage(input: {
  items: Contact[]
  total: number
  page: number
  q: string
  tag: string
  source: SourceFilter
  tags: { tag: string; count: number }[]
  csrf: string
}): string {
  const pageSize = 40
  const pages = Math.max(1, Math.ceil(input.total / pageSize))
  const params = new URLSearchParams()
  if (input.q) params.set('q', input.q)
  if (input.tag) params.set('tag', input.tag)
  if (input.source !== 'all') params.set('source', input.source)
  const exportQuery = params.toString()
  const rows = input.items.map((contact) => `<tr>
    <td>${esc(formatRuPhone(contact.phone))}</td>
    <td>${esc(contact.name || '—')}</td>
    <td>${contact.sources.map((source) => `<span class="badge ${source === 'whatsapp' ? 'wa' : 'phone'}">${source === 'whatsapp' ? 'WhatsApp' : 'Телефон'}</span>`).join(' ')}</td>
    <td>
      <form method="post" action="/contacts/${contact.id}/tags" class="row">
        <input type="hidden" name="csrf" value="${esc(input.csrf)}">
        <input name="tags" value="${esc(contact.tags.join(', '))}" placeholder="vip, грозный">
        <button class="ghost" type="submit">Ок</button>
      </form>
    </td>
    <td>
      <form method="post" action="/contacts/${contact.id}/delete" data-confirm="Удалить контакт?">
        <input type="hidden" name="csrf" value="${esc(input.csrf)}">
        <button class="ghost" type="submit">Удалить</button>
      </form>
    </td>
  </tr>`).join('')
  const options = (['all', 'whatsapp', 'phone', 'both'] as SourceFilter[]).map((source) =>
    `<option value="${source}" ${source === input.source ? 'selected' : ''}>${esc(SOURCE_FILTER_RU[source])}</option>`).join('')
  const tagOptions = input.tags.map((tag) => `<option value="${esc(tag.tag)}">`).join('')
  const prev = input.page > 1 ? `<a class="btn ghost" href="/contacts?${new URLSearchParams({ ...Object.fromEntries(params), page: String(input.page - 1) })}">Назад</a>` : ''
  const next = input.page < pages ? `<a class="btn ghost" href="/contacts?${new URLSearchParams({ ...Object.fromEntries(params), page: String(input.page + 1) })}">Дальше</a>` : ''
  return `<h1>Контакты</h1>
  <p class="lead">Два источника живут рядом. «Телефон» — файл с телефона. «WhatsApp» — чаты и контакты, которые отдал связанный аккаунт. У одного номера могут быть оба значка.</p>
  <div class="panel">
    <h2>Загрузить телефонную книгу</h2>
    <form method="post" action="/contacts/import" enctype="multipart/form-data" class="row">
      <input type="hidden" name="csrf" value="${esc(input.csrf)}">
      <input type="file" name="file" accept=".csv,.txt,.xlsx,.vcf,.vcard" required>
      <button type="submit">Импортировать</button>
    </form>
    <p class="hint">CSV с разделителем «;» или «,», XLSX, VCF. Столбцы: телефон / phone / номер, имя, метки. Повторный номер не дублируется: метки складываются, пустое имя не затирает уже сохранённое.</p>
  </div>
  <form class="row" method="get" action="/contacts">
    <label><span>Поиск</span><input type="search" name="q" value="${esc(input.q)}"></label>
    <label><span>Метка</span><input name="tag" list="tag-list" value="${esc(input.tag)}"></label>
    <datalist id="tag-list">${tagOptions}</datalist>
    <label><span>Источник</span><select name="source">${options}</select></label>
    <button class="ghost" type="submit">Фильтр</button>
    <a class="btn ghost" href="/contacts/export/csv?${exportQuery}">CSV</a>
    <a class="btn ghost" href="/contacts/export/xlsx?${exportQuery}">XLSX</a>
  </form>
  <p class="muted">Найдено: ${input.total}. Страница ${input.page} из ${pages}.</p>
  <div class="panel">
    ${rows ? `<table><tr><th>Телефон</th><th>Имя</th><th>Источник</th><th>Метки</th><th></th></tr>${rows}</table>` : '<p>Никого не нашли.</p>'}
    <p class="row">${prev}${next}</p>
  </div>`
}

export function importRunPage(run: ImportRun): string {
  const rows = run.issues.map((issue) => `<tr><td>${issue.row ?? '—'}</td><td>${esc(issue.raw)}</td><td>${esc(issue.reason)}</td></tr>`).join('')
  return `<h1>Импорт ${esc(run.filename)}</h1>
  <p>Добавлено ${run.added}, обновлено ${run.updated}, пропущено ${run.skipped}, дублей в файле ${run.merged}.</p>
  ${rows ? `<div class="panel"><table><tr><th>Строка</th><th>Как было</th><th>Почему</th></tr>${rows}</table></div>` : '<p>Ошибочных строк нет.</p>'}
  ${run.skipped > run.issues.length ? `<p class="muted">Показаны первые ${run.issues.length} замечаний.</p>` : ''}
  <p><a href="/contacts">К контактам</a></p>`
}

export function statusFormPage(input: {
  accounts: Account[]
  tags: { tag: string; count: number }[]
  csrf: string
  batchSize: number
  batchDelayMs: number
}): string {
  const accounts = input.accounts.map((account) => `<option value="${esc(account.id)}">${esc(account.label)}${account.phone ? ` (${formatRuPhone(account.phone)})` : ''} — ${esc(ACCOUNT_STATUS_RU[account.status])}</option>`).join('')
  const tags = input.tags.map((tag) => `<option value="${esc(tag.tag)}">`).join('')
  return `<h1>Новая публикация</h1>
  <p class="lead">Статус уходит в status@broadcast пачками по ${input.batchSize} номеров с паузой ${Math.round(input.batchDelayMs / 1000)} с. Большой список даёт несколько копий у вас в ленте: каждый зритель видит свою пачку один раз.</p>
  <form id="status-form" class="panel" method="post" action="/status" enctype="multipart/form-data" data-batch-size="${input.batchSize}" data-batch-delay="${input.batchDelayMs}">
    <input type="hidden" name="csrf" value="${esc(input.csrf)}">
    <p><label><span>Номер</span><select name="account_id" required>${accounts || '<option value="">Сначала подключите номер</option>'}</select></label></p>
    <p>
      <label><input type="radio" name="kind" value="text" checked> Текст</label>
      <label><input type="radio" name="kind" value="image"> Изображение</label>
      <label><input type="radio" name="kind" value="video"> Видео</label>
    </p>
    <div data-kind="text">
      <p><label><span>Текст</span><textarea name="text" maxlength="700"></textarea></label></p>
      <p class="row">
        <label><span>Цвет фона</span><input type="color" name="background_color" value="#0e6b52"></label>
        <label><span>Шрифт</span>
          <select name="font">
            <option value="0">Обычный</option>
            <option value="1">С засечками</option>
            <option value="2">Рукописный</option>
          </select>
        </label>
      </p>
    </div>
    <div data-kind="image" class="hidden">
      <p><label><span>Картинка</span><input type="file" name="image" accept="image/jpeg,image/png,image/webp"></label></p>
    </div>
    <div data-kind="video" class="hidden">
      <p><label><span>Видео</span><input type="file" name="video" accept="video/mp4,video/quicktime,video/webm"></label></p>
      <p class="hint">Ролик заранее кодируется в H.264 High, до 720×1280, около 2,5 Мбит/с. WhatsApp всё равно пережмёт статус, но так картинка страдает меньше. Уже подходящий файл не перекодируется.</p>
    </div>
    <p><label><span>Подпись к медиа</span><input type="text" name="caption" maxlength="1024"></label></p>
    <h3>Кому показать</h3>
    <p>
      <label><input type="radio" name="audience_source" value="any" checked> ${esc(AUDIENCE_RU.any)}</label>
      <label><input type="radio" name="audience_source" value="whatsapp"> ${esc(AUDIENCE_RU.whatsapp)}</label>
      <label><input type="radio" name="audience_source" value="phone"> ${esc(AUDIENCE_RU.phone)}</label>
    </p>
    <p><label><span>Метка, если нужна</span><input name="tag" list="tag-list" placeholder="пусто — без фильтра по метке"></label></p>
    <datalist id="tag-list">${tags}</datalist>
    <p id="audience-count" class="hint">Считаем аудиторию…</p>
    <p id="publish-cooldown" class="hint" hidden></p>
    <p class="hint">Аудитория считается в момент отправки. «Только чаты WhatsApp» включает и тех, у кого дополнительно есть телефонная книга.</p>
    <h3>Когда</h3>
    <p>
      <label><input type="radio" name="when" value="now" checked> Сейчас</label>
      <label><input type="radio" name="when" value="schedule"> Запланировать</label>
    </p>
    <p id="schedule-field" class="hidden"><label><span>Московское время</span><input type="datetime-local" name="scheduled_at"></label></p>
    <div id="story-preview" class="story-card preview"><p>Здесь будет предпросмотр</p></div>
    <button type="submit">Опубликовать статус</button>
  </form>`
}

export function statusListPage(posts: StatusPost[], accounts: Map<string, Account>): string {
  const rows = posts.map((post) => `<tr>
    <td><a href="/status/${post.id}">#${post.id}</a></td>
    <td>${esc(accounts.get(post.accountId)?.label || 'Удалённый номер')}</td>
    <td>${esc(KIND_RU[post.kind])}</td>
    <td>${esc(AUDIENCE_RU[post.audienceSource])}${post.audienceTag ? `, ${esc(post.audienceTag)}` : ''}</td>
    <td>${post.successRecipients}/${post.totalRecipients}</td>
    <td>${post.deletedAt ? badge('cancelled', 'Удалён') : badge(post.status, POST_STATUS_RU[post.status])}</td>
    <td>${esc(formatMoscow(post.scheduledAt || post.createdAt))}</td>
  </tr>`).join('')
  return `<h1>Публикации</h1>
  <p><a class="btn" href="/status/new">Новая публикация</a></p>
  <div class="panel">
    ${rows ? `<table><tr><th></th><th>Номер</th><th>Тип</th><th>Аудитория</th><th>Доставлено</th><th>Статус</th><th>Когда</th></tr>${rows}</table>` : '<p>Публикаций ещё нет.</p>'}
  </div>`
}

export function statusDetailPage(post: StatusPost, account: Account | null, batches: StatusBatch[], csrf: string, views = 0): string {
  const done = ['done', 'partial', 'failed', 'cancelled'].includes(post.status)
  const percent = post.totalRecipients ? Math.round(((post.successRecipients + post.failedRecipients) / post.totalRecipients) * 100) : 0
  const rows = batches.map((batch) => `<tr>
    <td>${batch.batchIndex + 1}</td>
    <td>${batch.recipientCount}</td>
    <td>${badge(batch.status, BATCH_STATUS_RU[batch.status])}</td>
    <td>${esc(batch.revokeStatus === 'revoked' ? 'отозван' : batch.revokeStatus === 'failed' ? 'не отозван' : batch.revokeStatus === 'pending' ? 'отзыв в очереди' : '')}</td>
    <td>${esc(batch.revokeError || batch.error || '')}</td>
    <td>${esc(formatMoscow(batch.sentAt))}</td>
  </tr>`).join('')
  const cancel = post.status === 'queued' || post.status === 'scheduled' || post.status === 'running'
    ? `<form method="post" action="/status/${post.id}/cancel"><input type="hidden" name="csrf" value="${esc(csrf)}"><button class="ghost" type="submit">Остановить</button></form>`
    : ''
  const retry = post.status === 'failed' || post.status === 'partial'
    ? `<form method="post" action="/status/${post.id}/retry"><input type="hidden" name="csrf" value="${esc(csrf)}"><button type="submit">Повторить</button></form>`
    : ''
  const until = post.notBefore && new Date(post.notBefore).getTime() > Date.now() ? post.notBefore : ''
  return `<h1>Публикация #${post.id}</h1>
  <div id="progress-root" data-url="/status/${post.id}/progress" data-finished="${done ? '1' : '0'}">
    <p id="progress-label">${badge(post.status, POST_STATUS_RU[post.status])}</p>
    <p id="progress-counts">${post.successRecipients} из ${post.totalRecipients}, пачек ${post.sentBatches} из ${post.totalBatches}</p>
    <div class="bar"><span id="progress-fill" style="width:${percent}%"></span></div>
    ${post.error ? `<p class="muted">${esc(post.error)}</p>` : ''}
    ${until ? `<p id="publish-cooldown" data-until="${esc(until)}">Пауза до ${esc(formatMoscow(until))}</p>` : ''}
    <p><a href="/status/${post.id}/viewers">👁 ${views}</a></p>
  </div>
  <div class="panel">
    <p>Номер: ${esc(account?.label || 'Удалённый номер')}</p>
    <p>Тип: ${esc(KIND_RU[post.kind])}</p>
    <p>Аудитория: ${esc(AUDIENCE_RU[post.audienceSource])}${post.audienceTag ? `, метка «${esc(post.audienceTag)}»` : ''}</p>
    <p>Когда: ${esc(formatMoscow(post.scheduledAt || post.createdAt))}</p>
    ${post.body ? `<p>Текст: ${esc(post.body)}</p>` : ''}
    ${post.caption ? `<p>Подпись: ${esc(post.caption)}</p>` : ''}
    ${post.originalName ? `<p>Файл: ${esc(post.originalName)}</p>` : ''}
    <p class="row">${cancel}${retry}
      ${post.deletedAt ? '' : `<form method="post" action="/status/${post.id}/delete" data-confirm="Удалить этот статус у всех в WhatsApp? Это нельзя отменить."><input type="hidden" name="csrf" value="${esc(csrf)}"><button class="danger" type="submit">Удалить</button></form>`}
      ${post.deletedAt && batches.some((batch) => batch.revokeStatus === 'failed') ? `<form method="post" action="/status/${post.id}/revoke-retry"><input type="hidden" name="csrf" value="${esc(csrf)}"><button type="submit">Повторить удаление</button></form>` : ''}
    </p>
  </div>
  ${rows ? `<div class="panel"><table><tr><th>Пачка</th><th>Номеров</th><th>Отправка</th><th>Отзыв</th><th>Ошибка</th><th>Время</th></tr>${rows}</table></div>` : ''}`
}

export function storiesPage(input: {
  posts: StatusPost[]
  accounts: Map<string, Account>
  views: Map<number, number>
  tags: { tag: string; count: number }[]
  csrf: string
  batchSize: number
  batchDelayMs: number
  maxVideoSeconds: number
  showDeleted: boolean
  failedRevokes: Map<number, boolean>
}): string {
  const cards = input.posts.map((post) => {
    const expires = statusExpiresAt(post.finishedAt || post.createdAt)
    const live = expires ? new Date(expires).getTime() > Date.now() : false
    const initial = (input.accounts.get(post.accountId)?.label || 'WA').slice(0, 1)
    const thumb = post.thumbPath ? `/media/${post.id}/thumb` : ''
    return `<div class="story-item ${post.deletedAt ? 'deleted' : ''}">
      <button type="button" class="story-ring ${live ? '' : 'expired'}" data-open-story="${post.id}" data-status="${esc(post.status)}" data-progress="/status/${post.id}/progress">
        <span class="ring-face ${post.status === 'queued' || post.status === 'running' ? 'progress' : ''}">${thumb ? `<img src="${esc(thumb)}" alt="">` : esc(initial)}</span>
        <small>${post.deletedAt ? 'Удалён' : esc(formatMoscow(post.finishedAt || post.createdAt))}</small>
      </button>
      ${post.deletedAt
        ? (input.failedRevokes.get(post.id)
          ? `<form id="delete-story-${post.id}" method="post" action="/status/${post.id}/revoke-retry" data-confirm="Повторить отзыв этого статуса в WhatsApp?"><input type="hidden" name="csrf" value="${esc(input.csrf)}"><button class="ghost" type="submit">Повторить</button></form>`
          : '')
        : `<form id="delete-story-${post.id}" method="post" action="/status/${post.id}/delete" data-confirm="Удалить этот статус у всех в WhatsApp? Это нельзя отменить."><input type="hidden" name="csrf" value="${esc(input.csrf)}"><button class="ghost" type="submit">Удалить</button></form>`}
    </div>`
  }).join('')
  const data = input.posts.map((post) => ({
    id: post.id,
    kind: post.kind,
    text: post.body,
    caption: post.caption,
    color: post.backgroundColor || '#0e6b52',
    mediaUrl: post.mediaPath ? `/media/${post.id}` : '',
    posted: formatMoscow(post.finishedAt || post.createdAt),
    expires: statusExpiresAt(post.finishedAt || post.createdAt),
    views: input.views.get(post.id) ?? 0,
    label: input.accounts.get(post.accountId)?.label || 'Номер',
    deleted: Boolean(post.deletedAt),
  }))
  const toggle = input.showDeleted
    ? '<a class="btn ghost" href="/stories">Скрыть удалённые</a>'
    : '<a class="btn ghost" href="/stories?deleted=1">Показать удалённые</a>'
  return `<h1>Мои статусы</h1>
  <p class="lead">Лента как в WhatsApp: кольцо, полноэкранный просмотр и сколько человек открыли статус. Удаление отзывает статус у всех, кому он ещё не истёк.</p>
  <p>${toggle}</p>
  <div class="story-row">${cards || '<p>Опубликованных статусов пока нет.</p>'}</div>
  <div id="story-stage" class="story-stage hidden" hidden>
    <button type="button" class="story-close" id="story-close">Закрыть</button>
    <article class="story-card" id="story-card"></article>
  </div>
  ${jsonScript('story-data', data)}
  <div class="wa-actions">
    <button type="button" class="wa-plus" id="add-status">＋<span>Статус</span></button>
    <button type="button" class="wa-text" id="add-text">✎<span>Текст</span></button>
  </div>
  <input id="media-files" type="file" accept="image/*,video/*" multiple hidden>
  <div id="wa-composer" data-csrf="${esc(input.csrf)}" data-max="${input.maxVideoSeconds}" data-accounts="${esc(JSON.stringify([...input.accounts.values()].map((account) => ({ id: account.id, label: account.label }))))}" data-tags="${esc(JSON.stringify(input.tags.map((tag) => tag.tag)))}"></div>
  <script src="/assets/composer.js"></script>`
}

export function viewersPage(input: {
  post: StatusPost
  items: { phone: string; name: string; viewedAt: string }[]
  total: number
  page: number
  q: string
  tag: string
  source: SourceFilter
  tags: { tag: string; count: number }[]
}): string {
  const params = new URLSearchParams()
  if (input.q) params.set('q', input.q)
  if (input.tag) params.set('tag', input.tag)
  if (input.source !== 'all') params.set('source', input.source)
  const query = params.toString()
  const options = (['all', 'whatsapp', 'phone', 'both'] as SourceFilter[]).map((source) =>
    `<option value="${source}" ${source === input.source ? 'selected' : ''}>${esc(SOURCE_FILTER_RU[source])}</option>`).join('')
  const rows = input.items.map((item) => `<tr>
    <td>${esc(item.name || '—')}</td>
    <td>${esc(formatRuPhone(item.phone))}</td>
    <td>${esc(formatMoscow(item.viewedAt))}</td>
  </tr>`).join('')
  const pages = Math.max(1, Math.ceil(input.total / 50))
  return `<h1>Кто смотрел #${input.post.id}</h1>
  <p class="lead">👁 ${input.total}. Список новее сверху. WhatsApp присылает квитанцию только если у человека включены отчёты о прочтении, поэтому цифра может быть меньше, чем в приложении.</p>
  <form class="row" method="get" action="/status/${input.post.id}/viewers">
    <label><span>Поиск</span><input type="search" name="q" value="${esc(input.q)}"></label>
    <label><span>Метка</span><input name="tag" value="${esc(input.tag)}" list="tag-list"></label>
    <datalist id="tag-list">${input.tags.map((tag) => `<option value="${esc(tag.tag)}">`).join('')}</datalist>
    <label><span>Источник</span><select name="source">${options}</select></label>
    <button class="ghost" type="submit">Фильтр</button>
    <a class="btn ghost" href="/status/${input.post.id}/viewers.csv?${query}">CSV</a>
  </form>
  <div class="panel">
    ${rows ? `<table><tr><th>Имя</th><th>Телефон</th><th>Когда</th></tr>${rows}</table>` : '<p>Просмотров с квитанцией пока нет.</p>'}
    <p class="muted">Страница ${input.page} из ${pages}.</p>
  </div>
  <p><a href="/stories">К статусам</a></p>`
}

function jsonScript(id: string, data: unknown): string {
  return `<script type="application/json" id="${id}">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`
}

export function healthPage(input: {
  accounts: Account[]
  discovered: Map<string, number>
  queue: { queued: number; scheduled: number; running: number }
  uptime: string
  batchSize: number
  batchDelayMs: number
  proxyLabel: string | null
  proxyCheck: { ok: boolean; direct: boolean; latencyMs: number; status?: number; error?: string; at: string } | null
  csrf: string
  logs: { level: string; message: string; createdAt: string; accountId: string | null }[]
}): string {
  const rows = input.accounts.map((account) => `<tr>
    <td>${esc(account.label)}</td>
    <td>${badge(account.status, ACCOUNT_STATUS_RU[account.status])}</td>
    <td>${esc(account.phone ? formatRuPhone(account.phone) : '—')}</td>
    <td>${input.discovered.get(account.id) ?? 0}</td>
    <td>${account.historyComplete ? 'да' : 'ещё нет'}</td>
    <td>${esc(account.lastError || '')}</td>
  </tr>`).join('')
  const logs = input.logs.map((entry) => `<tr>
    <td>${esc(formatMoscow(entry.createdAt))}</td>
    <td>${esc(entry.level)}</td>
    <td>${esc(entry.message)}</td>
  </tr>`).join('')
  const proxyLine = input.proxyLabel
    ? `Прокси WhatsApp: ${esc(input.proxyLabel)}. Панель открывается напрямую.`
    : 'Прокси WhatsApp не задан, сокет и медиа идут напрямую с этого сервера.'
  const check = input.proxyCheck
  const checkLine = !check
    ? ''
    : check.ok
      ? `<p>Последняя проверка ${esc(formatMoscow(check.at))}: web.whatsapp.com ответил ${check.status} за ${check.latencyMs} мс ${check.direct ? 'напрямую' : 'через прокси'}.</p>`
      : `<p>Последняя проверка ${esc(formatMoscow(check.at))} не удалась за ${check.latencyMs} мс ${check.direct ? 'напрямую' : 'через прокси'}: ${esc(check.error || 'ошибка')}.</p>`
  return `<h1>Журнал и связь</h1>
  <p class="muted">Процесс работает ${esc(input.uptime)}. Пачка статуса: ${input.batchSize} номеров, пауза ${Math.round(input.batchDelayMs / 1000)} с. Очередь ${input.queue.queued} / план ${input.queue.scheduled} / сейчас ${input.queue.running}.</p>
  <div class="panel">
    <h2>Прокси</h2>
    <p>${proxyLine}</p>
    ${checkLine}
    <form method="post" action="/health/proxy-check">
      <input type="hidden" name="csrf" value="${esc(input.csrf)}">
      <button type="submit">Проверить прокси</button>
    </form>
    <p class="hint">Проверка открывает https://web.whatsapp.com тем же каналом, что сокет и загрузка медиа. Запрос самой панели к вам в браузер через прокси не идёт.</p>
  </div>
  <div class="panel"><table>
    <tr><th>Номер</th><th>Состояние</th><th>Телефон</th><th>Кэш WhatsApp</th><th>История</th><th>Сообщение</th></tr>
    ${rows || '<tr><td colspan="6">Номеров нет</td></tr>'}
  </table></div>
  <div class="panel"><table>
    <tr><th>Время</th><th>Уровень</th><th>Событие</th></tr>
    ${logs || '<tr><td colspan="3">Журнал пуст</td></tr>'}
  </table></div>`
}

export function accountStatusLabel(status: AccountStatus): string {
  return ACCOUNT_STATUS_RU[status]
}

export function postStatusLabel(status: PostStatus): string {
  return POST_STATUS_RU[status]
}
