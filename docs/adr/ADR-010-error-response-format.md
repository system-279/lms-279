# ADR-010: エラーレスポンス形式統一

## ステータス
承認済み

## コンテキスト
APIエラーレスポンスの一貫性確保

## 決定
AppErrorクラス階層（BadRequestError, NotFoundError, UnauthorizedError, ForbiddenError等）と統一レスポンス形式を採用

## 根拠
クライアント側のエラーハンドリング統一。HTTPステータスコードとアプリケーションエラーコードの併用

## 影響
全エラーは { error: { code, message, details? } } 形式。グローバルエラーハンドラーミドルウェアで一元処理
