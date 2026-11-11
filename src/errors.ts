export class WaSendError extends Error {
  readonly pause: boolean
  readonly code?: number

  constructor(message: string, opts: { pause?: boolean; code?: number } = {}) {
    super(message)
    this.name = 'WaSendError'
    this.pause = opts.pause ?? false
    this.code = opts.code
  }
}

export class ImportFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImportFormatError'
  }
}
