# ADR-025: セキュリティ強化

## ステータス
承認済み

## コンテキスト
Phase 1-5でコア機能は完成したが、本番運用に必要なセキュリティ対策が不足している。OWASP推奨のHTTPセキュリティヘッダ、レート制限によるブルートフォース防止が必要。

## 決定

### API（Express）
- **Helmet**: セキュリティヘッダの自動付与（X-Content-Type-Options, X-Frame-Options, HSTS等）
- **express-rate-limit**: IPベースのレート制限
  - グローバル: 100リクエスト/分/IP
  - 認証系（テナント登録）: 10リクエスト/分/IP

### Web（Next.js）
- `poweredByHeader: false` でフレームワーク情報非公開
- カスタムヘッダ: X-Frame-Options: DENY, X-Content-Type-Options: nosniff, Referrer-Policy, Permissions-Policy

## 理由
- Helmetは業界標準でExpressセキュリティヘッダのデファクト
- レート制限はCloud Run単体インスタンス内で機能。将来的にRedisバックエンドへの移行も可能
- Next.jsの`headers()`で一括管理が可能

## 影響
- Cloud Runのスケールアウト時、インスタンスごとにカウントが独立する（完全な分散レート制限にはRedisが必要）
- 現段階のトラフィック規模では単体インスタンスで十分
