class TapflowError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = new.target.name
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export class ValidationError extends TapflowError {}

export class PlatformError extends TapflowError {}
