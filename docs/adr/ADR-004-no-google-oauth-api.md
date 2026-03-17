# ADR-004: Google OAuth API連携の見送り

## ステータス
承認済み

## コンテキスト
Google Classroom APIとの連携を検討したが、OAuth審査の時間とコストが大きい

## 決定
Google Classroom API / Google Forms APIとの連携は実装しない

## 根拠
OAuth審査プロセスが長期化するリスク。講座・受講者情報は管理画面で手動管理する方が初期段階では現実的

## 影響
講座情報の自動同期なし。管理者が手動で講座・受講者を登録
