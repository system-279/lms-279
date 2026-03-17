/**
 * 構造化ログユーティリティ
 *
 * JSON形式でログを出力し、Cloud Loggingとの統合を容易にする
 */

/**
 * ログレベル定数
 */
export const LogLevel = {
  DEBUG: "debug",
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
} as const;

export type LogLevelType = (typeof LogLevel)[keyof typeof LogLevel];

/**
 * ログエントリの基本構造
 */
interface LogEntry {
  timestamp: string;
  level: LogLevelType;
  message: string;
  [key: string]: unknown;
}

/**
 * ログメタデータ
 */
type LogMetadata = Record<string, unknown>;

/**
 * エラーオブジェクトをシリアライズ可能な形式に変換
 */
function serializeError(error: Error): Record<string, unknown> {
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
}

/**
 * メタデータ内のErrorオブジェクトを処理
 */
function processMetadata(metadata: LogMetadata): LogMetadata {
  const processed: LogMetadata = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (value instanceof Error) {
      processed[key] = serializeError(value);
    } else {
      processed[key] = value;
    }
  }

  return processed;
}

/**
 * ログエントリを作成
 */
function createLogEntry(
  level: LogLevelType,
  message: string,
  metadata?: LogMetadata
): LogEntry {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
  };

  if (metadata) {
    Object.assign(entry, processMetadata(metadata));
  }

  return entry;
}

/**
 * ログエントリを出力
 */
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

/**
 * ロガーインターフェース
 */
export interface Logger {
  debug(message: string, metadata?: LogMetadata): void;
  info(message: string, metadata?: LogMetadata): void;
  warn(message: string, metadata?: LogMetadata): void;
  error(message: string, metadata?: LogMetadata): void;
  child(context: LogMetadata): Logger;
}

/**
 * ロガー実装を作成
 */
function createLogger(baseContext: LogMetadata = {}): Logger {
  const log = (
    level: LogLevelType,
    message: string,
    metadata?: LogMetadata
  ): void => {
    const entry = createLogEntry(level, message, {
      ...baseContext,
      ...metadata,
    });
    output(level, entry);
  };

  return {
    debug: (message, metadata) => log(LogLevel.DEBUG, message, metadata),
    info: (message, metadata) => log(LogLevel.INFO, message, metadata),
    warn: (message, metadata) => log(LogLevel.WARN, message, metadata),
    error: (message, metadata) => log(LogLevel.ERROR, message, metadata),
    child: (context) => createLogger({ ...baseContext, ...context }),
  };
}

/**
 * デフォルトロガーインスタンス
 */
export const logger = createLogger();
