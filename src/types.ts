export type ContactSource = 'whatsapp' | 'phone'

/** Фильтр списка и выгрузки. `both` — номер есть в обоих источниках. */
export type SourceFilter = 'all' | 'whatsapp' | 'phone' | 'both'

/** Аудитория статуса. `any` — оба списка вместе. */
export type AudienceSource = 'any' | 'whatsapp' | 'phone'

export type AccountStatus =
  | 'created'
  | 'connecting'
  | 'qr'
  | 'connected'
  | 'reconnecting'
  | 'logged_out'
  | 'error'

export type PostStatus =
  | 'scheduled'
  | 'queued'
  | 'running'
  | 'done'
  | 'partial'
  | 'failed'
  | 'cancelled'

export type BatchStatus = 'pending' | 'sent' | 'failed'
export type PostKind = 'text' | 'image' | 'video'

export type ContactDraft = {
  phone: string
  name: string
  nameRank: number
  tags: string[]
  sources: ContactSource[]
}

export type Account = {
  id: string
  label: string
  phone: string | null
  status: AccountStatus
  lastError: string | null
  connectedAt: string | null
  autoConnect: boolean
  historyComplete: boolean
  createdAt: string
  updatedAt: string
}

export type Contact = {
  id: number
  phone: string
  name: string
  nameRank: number
  tags: string[]
  sources: ContactSource[]
  createdAt: string
  updatedAt: string
}

export type StatusPost = {
  id: number
  accountId: string
  kind: PostKind
  body: string
  caption: string
  mediaPath: string | null
  thumbPath: string | null
  mediaWidth: number | null
  mediaHeight: number | null
  originalName: string | null
  backgroundColor: string | null
  font: number | null
  audienceSource: AudienceSource
  audienceTag: string | null
  scheduledAt: string | null
  notBefore: string | null
  status: PostStatus
  totalRecipients: number
  totalBatches: number
  sentBatches: number
  successRecipients: number
  failedRecipients: number
  error: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  deletedAt: string | null
}

export type StatusBatch = {
  id: number
  postId: number
  batchIndex: number
  recipientCount: number
  jids: string[]
  status: BatchStatus
  error: string | null
  waMessageId: string | null
  sentAt: string | null
  revokeStatus: 'pending' | 'revoked' | 'failed' | null
  revokeError: string | null
}

export type ImportIssue = {
  row?: number
  raw: string
  reason: string
}

export type StatusView = {
  viewerJid: string
  phone: string
  name: string
  viewedAt: string
}

export type ImportRun = {
  id: number
  filename: string
  added: number
  updated: number
  skipped: number
  merged: number
  issues: ImportIssue[]
  createdAt: string
}
