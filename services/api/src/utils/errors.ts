/**
 * 統一エラーハンドリング
 *
 * ADR-0025: エラーレスポンス形式の統一
 */

/**
 * エラーコード定数
 */
export const ErrorCode = {
  // 400 Bad Request
  INVALID_REQUEST: "INVALID_REQUEST",
  VALIDATION_ERROR: "VALIDATION_ERROR",

  // 401 Unauthorized
  UNAUTHORIZED: "UNAUTHORIZED",
  TOKEN_EXPIRED: "TOKEN_EXPIRED",
  TOKEN_INVALID: "TOKEN_INVALID",

  // 403 Forbidden
  FORBIDDEN: "FORBIDDEN",

  // 404 Not Found
  NOT_FOUND: "NOT_FOUND",

  // 409 Conflict
  CONFLICT: "CONFLICT",
  ALREADY_EXISTS: "ALREADY_EXISTS",

  // 429 Too Many Requests
  RATE_LIMIT_EXCEEDED: "RATE_LIMIT_EXCEEDED",

  // 500 Internal Server Error
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * エラーレスポンス形式
 */
export interface ErrorResponseBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/**
 * アプリケーションエラー基底クラス
 */
export class AppError extends Error {
  public readonly code: ErrorCodeType;
  public readonly statusCode: number;
  public readonly details?: unknown;

  constructor(
    code: ErrorCodeType,
    message: string,
    statusCode: number,
    details?: unknown
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;

    // Error.captureStackTraceが存在する場合のみ呼び出し
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * JSON形式に変換
   */
  toJSON(): ErrorResponseBody {
    const response: ErrorResponseBody = {
      error: {
        code: this.code,
        message: this.message,
      },
    };

    if (this.details !== undefined) {
      response.error.details = this.details;
    }

    return response;
  }
}

/**
 * 400 Bad Request エラー
 */
export class BadRequestError extends AppError {
  constructor(message = "Bad request") {
    super(ErrorCode.INVALID_REQUEST, message, 400);
    this.name = "BadRequestError";
  }

  /**
   * バリデーションエラーを作成
   */
  static validation(fields: Record<string, string>): AppError {
    return new AppError(
      ErrorCode.VALIDATION_ERROR,
      "Invalid request parameters",
      400,
      { fields }
    );
  }
}

/**
 * 401 Unauthorized エラー
 */
export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required") {
    super(ErrorCode.UNAUTHORIZED, message, 401);
    this.name = "UnauthorizedError";
  }

  /**
   * トークン期限切れエラーを作成
   */
  static tokenExpired(): AppError {
    return new AppError(ErrorCode.TOKEN_EXPIRED, "Token has expired", 401);
  }

  /**
   * トークン不正エラーを作成
   */
  static tokenInvalid(): AppError {
    return new AppError(ErrorCode.TOKEN_INVALID, "Invalid token", 401);
  }
}

/**
 * 403 Forbidden エラー
 */
export class ForbiddenError extends AppError {
  constructor(message = "Access denied") {
    super(ErrorCode.FORBIDDEN, message, 403);
    this.name = "ForbiddenError";
  }
}

/**
 * 404 Not Found エラー
 */
export class NotFoundError extends AppError {
  constructor(message = "Resource not found") {
    super(ErrorCode.NOT_FOUND, message, 404);
    this.name = "NotFoundError";
  }
}

/**
 * 409 Conflict エラー
 */
export class ConflictError extends AppError {
  constructor(message = "Resource conflict") {
    super(ErrorCode.CONFLICT, message, 409);
    this.name = "ConflictError";
  }

  /**
   * 既存リソースエラーを作成
   */
  static alreadyExists(resource: string): AppError {
    return new AppError(
      ErrorCode.ALREADY_EXISTS,
      `${resource} already exists`,
      409
    );
  }
}

/**
 * 429 Rate Limit エラー
 */
export class RateLimitError extends AppError {
  constructor(message = "Rate limit exceeded") {
    super(ErrorCode.RATE_LIMIT_EXCEEDED, message, 429);
    this.name = "RateLimitError";
  }
}

/**
 * 500 Internal Server Error
 */
export class InternalError extends AppError {
  constructor(message = "Internal server error") {
    super(ErrorCode.INTERNAL_ERROR, message, 500);
    this.name = "InternalError";
  }
}
