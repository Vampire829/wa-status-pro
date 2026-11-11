import type { AccountStatus, AudienceSource, BatchStatus, ContactSource, PostKind, PostStatus, SourceFilter } from './types.js'

export const ACCOUNT_STATUS_RU: Record<AccountStatus, string> = {
  created: 'Создан',
  connecting: 'Подключение',
  qr: 'Ждёт QR',
  connected: 'Подключён',
  reconnecting: 'Переподключение',
  logged_out: 'Сессия сброшена',
  error: 'Ошибка',
}

export const POST_STATUS_RU: Record<PostStatus, string> = {
  scheduled: 'Запланирован',
  queued: 'В очереди',
  running: 'Публикуется',
  done: 'Опубликован',
  partial: 'Частично',
  failed: 'Ошибка',
  cancelled: 'Отменён',
}

export const BATCH_STATUS_RU: Record<BatchStatus, string> = {
  pending: 'Ожидает',
  sent: 'Отправлено',
  failed: 'Ошибка',
}

export const KIND_RU: Record<PostKind, string> = {
  text: 'Текст',
  image: 'Изображение',
  video: 'Видео',
}

export const SOURCE_RU: Record<ContactSource, string> = {
  phone: 'Телефон',
  whatsapp: 'WhatsApp',
}

export const SOURCE_FILTER_RU: Record<SourceFilter, string> = {
  all: 'Все источники',
  whatsapp: 'Чаты WhatsApp',
  phone: 'Телефонная книга',
  both: 'Есть в обоих',
}

export const AUDIENCE_RU: Record<AudienceSource, string> = {
  any: 'Оба источника',
  whatsapp: 'Только чаты WhatsApp',
  phone: 'Только телефонная книга',
}

export function sourceListLabel(sources: ContactSource[]): string {
  return sources.map((source) => SOURCE_RU[source]).join(', ')
}
