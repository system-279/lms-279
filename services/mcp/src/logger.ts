/**
 * 構造化ログユーティリティ
 *
 * JSON形式でログを出力し、Cloud Loggingとの統合を容易にする。
 * services/api/src/utils/logger.ts と同一実装（フレームワーク依存なし、
 * ワークスペースを跨いだ共有パッケージ化はスコープ外のためコピー）。
 */

export const LogLevel = {
  DEBUG: "debug",
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
} as const;

export type LogLevelType = (typeof LogLevel)[keyof typeof LogLevel];

/**
 * Cloud Logging severity マッピング
 * https://cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry#LogSeverity
 */
const severityMap: Record<LogLevelType, string> = {
  debug: "DEBUG",
  info: "INFO",
  warn: "WARNING",
  error: "ERROR",
};

interface LogEntry {
  severity: string;
  timestamp: string;
  level: LogLevelType;
  message: string;
  [key: string]: unknown;
}

type LogMetadata = Record<string, unknown>;

function serializeError(error: Error): Record<string, unknown> {
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
}

function processMetadata(metadata: LogMetadata): LogMetadata {
  const processed: LogMetadata = {};
  for (const [key, value] of Object.entries(metadata)) {
    processed[key] = value instanceof Error ? serializeError(value) : value;
  }
  return processed;
}

function createLogEntry(level: LogLevelType, message: string, metadata?: LogMetadata): LogEntry {
  const entry: LogEntry = {
    severity: severityMap[level],
    timestamp: new Date().toISOString(),
    level,
    message,
  };
  if (metadata) {
    Object.assign(entry, processMetadata(metadata));
  }
  return entry;
}

function output(level: LogLevelType, entry: LogEntry): void {
  const json = JSON.stringify(entry);
  switch (level) {
    case LogLevel.ERROR:
      console.error(json);
      break;
    case LogLevel.WARN:
      console.warn(json);
      break;
    default:
      console.log(json);
  }
}

export interface Logger {
  debug(message: string, metadata?: LogMetadata): void;
  info(message: string, metadata?: LogMetadata): void;
  warn(message: string, metadata?: LogMetadata): void;
  error(message: string, metadata?: LogMetadata): void;
  child(context: LogMetadata): Logger;
}

function createLogger(baseContext: LogMetadata = {}): Logger {
  const log = (level: LogLevelType, message: string, metadata?: LogMetadata): void => {
    output(level, createLogEntry(level, message, { ...baseContext, ...metadata }));
  };

  return {
    debug: (message, metadata) => log(LogLevel.DEBUG, message, metadata),
    info: (message, metadata) => log(LogLevel.INFO, message, metadata),
    warn: (message, metadata) => log(LogLevel.WARN, message, metadata),
    error: (message, metadata) => log(LogLevel.ERROR, message, metadata),
    child: (context) => createLogger({ ...baseContext, ...context }),
  };
}

export const logger = createLogger();
