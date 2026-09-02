# ADR-042: 運用通知の自動化（Google Chat 連携）

## ステータス

採用 (2026-09-02)

## コンテキスト

本番 LMS が安全に稼働しているかを人手で確認する手段が、従来「GitHub Actions のスケジュール失敗メール」と「必要時に手動で Cloud Logging を見る」しかなかった。開発者から、平日毎日の稼働確認と、エラー発生時の詳細な内容を Google Chat スペースへ自動投稿したいという要望があった。エラー内容は開発者が AI（Claude）へそのまま報告する材料になるため、原因究明に足る詳細さ（スタックトレース・発生箇所・時刻・Cloud Logging への導線）が要件となった。

**訂正事項**: 当初の依頼では「投稿は特定のメールアドレスのユーザーとして行われる」という前提があったが、これは誤りだった。共有された URL は Google Chat の受信 Webhook であり、投稿は指定ユーザーとしてではなく、その Webhook を作成した Chat アプリ（Bot）名で表示される。

本プランは初版を `codex`（GPT、独立診断 → 自己レビューの自白を見せた上での反証的再検証の2パス）と `grip`（自己可視化による判断支援）でクロスレビューし、High 指摘 9 件を反映した改訂版である。

## 決定事項

### 配置先

新規コードは `services/api` ではなく `services/notification`（既存の独立 Cloud Run サービス）に置く。理由: ヘルスチェック通知は「API が落ちたことを報告する」役目であり、API と同じ障害ドメインに同居させると、API が本当に落ちたときに報告できなくなる。

### 3経路構成

1. **可用性監視**: Cloud Monitoring Uptime Check + Alerting Policy（Cloud Run 5xx 率、`/health/ready` 失敗）→ Pub/Sub 通知チャネル → `notification` → Chat。ログが出ない障害（API 無応答・基盤障害）を検知するために追加した。
2. **平日毎日のヘルスチェック**: Cloud Scheduler（`0 9 * * 1-5`, JST）→ `notification /internal/health-report` → `api /health/ready` を呼び出し整形 → Chat。JST 日付を冪等キーにし、Cloud Scheduler の at-least-once retry による二重投稿を防ぐ。
3. **エラー発生時のリアルタイム通知**: `api` の `ReportedErrorEvent` 形式ログ → Cloud Logging Sink（`service_name="api"` かつ `jsonPayload."@type"` が ReportedErrorEvent のもののみ。`notification` 自身は除外し無限ループを防ぐ）→ Pub/Sub → `notification /internal/error-alert` → Chat。

### PII 対策: allowlist 方式

出口の正規表現マスクのみでは「PII を含めない」という決定要件を保証できないと判断し、Chat へ転送してよいフィールドを型で固定した allowlist（`chat-payload-allowlist.ts`）を採用した。転送するのは時刻・サービス名・エラー名・整形済みメッセージ・HTTP method・path（クエリ文字列は除去）・tenant ID・スタックの先頭数フレーム・Cloud Logging へのリンクのみ。受講者 ID・メールアドレス・URL クエリ全体・任意の追加 metadata は転送経路自体に乗らない設計にした上で、許可フィールドの中身（message / stack）に対してもメールアドレス・Bearer トークン・長い数字列のマスクを適用する（二重防御）。

### 集約(dedup)と flush

同一エラーの連続発生は 10 分ウィンドウで集約し、抑制件数を付記して次回投稿する。決定ロジック（`decideDedup`）は Firestore に依存しない pure 関数として切り出し、並行性の安全性は Firestore の `runTransaction` に委ねた。トランザクション競合時は有限リトライ後、集約をあきらめて個別投稿にフォールバックする（集約に失敗しても通知そのものは失われない）。ウィンドウが終了しても後続イベントが来ない場合に抑制件数が投稿されないまま残ることを防ぐため、Cloud Scheduler による定期 flush ジョブ（`/internal/flush`）を別途設けた。

### 認証: OIDC audience + caller email allowlist

Cloud Scheduler / Pub/Sub push からの呼び出しは OIDC ID Token で認証するが、audience 検証だけでは「同じ Cloud Run invoker 権限を持つ別 SA が別 endpoint を叩く」ケースを防げないため、caller（SA email）の allowlist 検証を追加した（`oidc-verify.ts`）。allowlist が空の場合は誰も許可しない（設定漏れによるオープン化を防ぐ）。

### Pub/Sub 配信保証

push subscription には DLQ（dead letter topic）を設定する。恒久失敗（整形不能・Chat webhook の 4xx 応答等）は 200 で ack しループさせず、transient 障害（ネットワーク例外・5xx）は 5xx で nack して再配信させる。

### notification 自身の障害検知

Chat のみに運用アラートを依存させると、Webhook 失効等で `notification` は正常でも Chat 投稿だけ失敗した場合に気づけない（Chat が単一障害点になる）。Chat 投稿の成功/失敗は `notification` 自身の構造化ログに出力し（`chat-client.ts`）、これを Cloud Monitoring のログベースメトリクスで監視し、連続失敗をメール通知で検知する副経路を設ける（`notification` は Sink の対象から除外しているため Chat には転送されない）。

## 検討したが見送った代替案

- **401/403/429 急増の個別 Chat 通知**: 価値はあるが Chat 通知というより Cloud Monitoring 全体設計の話であり、今回のスコープでは見送った。将来 Cloud Monitoring の閾値アラート対象として検討する。
- **Terraform 等の完全 IaC 化**: 既存インフラが gcloud ワンショットコマンドの手順書ベース運用のため、今回だけ IaC 化すると一貫性が崩れる。代わりに冪等な gcloud スクリプト化 + `describe` による実在確認で代替する。

## 既知の限界

- Firestore を使った集約(dedup)の実際の並行動作は、pure 関数のユニットテストと Firestore トランザクションの atomicity という信頼できるプリミティブへの委譲で担保しており、本番相当の高並行負荷での実機検証はしていない。
- `docs/runbook/monitoring-setup.md` の既存記述に `service_name=lms-api` という古い Cloud Run サービス名の参照があったため、本 ADR の実装に合わせて `service_name=api` へ修正した（別件の doc drift）。
