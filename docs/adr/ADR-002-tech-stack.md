# ADR-002: 技術スタックとバージョン

## ステータス
承認済み

## コンテキスト
プロジェクト全体の技術スタック統一

## 決定
Node.js v24.12.0+, TypeScript 5.9.3, Express 5.2.1, Next.js 16.1.1, React 19.2.3, Firestore 8.1.0

## 根拠
参考プロジェクトで安定運用実績あり。ES Modules統一（type: module）

## 影響
全サービスで同一バージョンを維持。package.jsonとdocs/tech-stack.mdで同期管理
