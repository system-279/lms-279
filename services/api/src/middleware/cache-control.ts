/**
 * Cache-Control ミドルウェア
 *
 * 読み取り系エンドポイントにキャッシュヘッダを付与
 */

import { RequestHandler } from "express";

/**
 * private キャッシュ（認証済みユーザー向けデータ）
 */
export function privateCache(maxAge: number): RequestHandler {
  return (_req, res, next) => {
    res.set("Cache-Control", `private, max-age=${maxAge}`);
    res.set("Vary", "Authorization, Cookie");
    next();
  };
}
