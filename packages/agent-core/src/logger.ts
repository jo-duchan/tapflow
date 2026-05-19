export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function resolveLevel(): number {
  const raw = process.env.LOG_LEVEL ?? 'info';
  return LEVELS[raw as LogLevel] ?? LEVELS.info;
}

function print(fn: (...args: unknown[]) => void, prefix: string, msg: string, meta: unknown): void {
  if (meta !== undefined) {
    fn(`[${prefix}] ${msg}`, meta);
  } else {
    fn(`[${prefix}] ${msg}`);
  }
}

class ConsoleLogger implements Logger {
  private readonly prefix: string;
  private readonly minLevel: number;

  constructor(prefix: string) {
    this.prefix = prefix;
    this.minLevel = resolveLevel();
  }

  debug(msg: string, meta?: unknown): void {
    if (this.minLevel > LEVELS.debug) return;
    print(console.debug, this.prefix, msg, meta);
  }

  info(msg: string, meta?: unknown): void {
    if (this.minLevel > LEVELS.info) return;
    print(console.log, this.prefix, msg, meta);
  }

  warn(msg: string, meta?: unknown): void {
    if (this.minLevel > LEVELS.warn) return;
    print(console.warn, this.prefix, msg, meta);
  }

  error(msg: string, meta?: unknown): void {
    if (this.minLevel > LEVELS.error) return;
    print(console.error, this.prefix, msg, meta);
  }
}

export function createLogger(prefix: string): Logger {
  return new ConsoleLogger(prefix);
}
