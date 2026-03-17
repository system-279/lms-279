# ADR-010: エラーレスポンス形式統一

## ステータス
改訂済み（旧: 承認済み）

## コンテキスト
APIエラーレスポンスの一貫性確保。

当初は `{ error: { code, message, details? } }` のネスト形式を定めていたが、classroom-check-in プロジェクトからの移植時にフラット形式が採用され、全ルーター（courses, users, videos, quizzes, quiz-attempts, analytics 等）で一貫してフラット形式が使用されていることが確認された。

## 決定
AppErrorクラス階層（BadRequestError, NotFoundError, UnauthorizedError, ForbiddenError等）は引き続き使用するが、ルーターレベルのエラーレスポンスは **フラット形式** を採用する。

```json
{
  "error": "not_found",
  "message": "Course not found"
}
```

ルーターでは以下のパターンを推奨する:

```ts
res.status(404).json({ error: "not_found", message: "Course not found" });
```

## 根拠
- フラット形式の方がシンプルで可読性が高い
- 全ルーターで一貫して使用されており、実装の実態に合致している
- classroom-check-in プロジェクトとの一貫性を維持できる
- クライアント側のエラーハンドリングが簡潔になる（`response.error` で直接エラーコードを参照可能）

## 影響
- 全エラーレスポンスは `{ error: "code", message: "..." }` のフラット形式を使用する
- AppErrorクラス階層はサーバー内部のエラー分類に引き続き利用可能
- グローバルエラーハンドラーミドルウェアもフラット形式で出力すること
- 旧仕様（`{ error: { code, message, details? } }` のネスト形式）は廃止
