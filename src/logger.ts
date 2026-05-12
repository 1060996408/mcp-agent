export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_LABEL: Record<LogLevel, string> = {
  debug: "DBG",
  info: "INF",
  warn: "WRN",
  error: "ERR",
};

export class Logger {
  private level: LogLevel;

  constructor(level: LogLevel = "info") {
    this.level = level;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  debug(msg: string, data?: unknown): void {
    this.log("debug", msg, data);
  }

  info(msg: string, data?: unknown): void {
    this.log("info", msg, data);
  }

  warn(msg: string, data?: unknown): void {
    this.log("warn", msg, data);
  }

  error(msg: string, data?: unknown): void {
    this.log("error", msg, data);
  }

  private log(level: LogLevel, msg: string, data?: unknown): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const ts = new Date().toISOString().slice(11, 23);
    const prefix = `[${ts}] [${LEVEL_LABEL[level]}]`;
    if (data !== undefined) {
      console.error(`${prefix} ${msg}`, typeof data === "string" ? data : JSON.stringify(data, null, 2));
    } else {
      console.error(`${prefix} ${msg}`);
    }
  }
}

export const logger = new Logger();
