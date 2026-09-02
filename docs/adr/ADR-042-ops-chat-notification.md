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

## 追加レビュー（PR #685、pr-review-toolkit 3系統並列）

codex review 3巡に加え、Claude 系の `code-reviewer` / `silent-failure-hunter` / `pr-test-analyzer` を並列起動し、以下を修正した:

- **PII**: `path` フィールドが無マスクで転送されていた（`/api/v2/super/admins/:email` 等）。既知の静的ルート名以外を `<id>` に畳む allowlist 方式（`sanitizePathForDisplay`）に変更
- **fingerprint**: `topStackFrames` の先頭行（実際は "TypeError: xxx" というヘッダ行）を fingerprint に使っており、`normalizeMessage` の効果を打ち消していた。実フレーム（"at ..." 形式）の先頭行を使うよう修正
- **Chat webhook の 429（レート制限）**: 恒久失敗として誤って ack していた。5xx・ネットワーク例外と同様 transient として nack するよう修正（`isTransientChatFailure`）
- **rollback**: ウィンドウ境界をまたいだ直後（decideDedup のロールオーバー分岐）の rollback で、直前ウィンドウの抑制件数が完全に消失するバグを修正（`restoreSuppressedCount` を渡し、ウィンドウ期限切れ状態として復元）
- **可観測性**: OIDC 検証失敗が一切ログされていなかった（認証層全断が不可視だった）ため `logger.warn`/`error` を追加。`app.ts` にグローバルエラーハンドラ（ADR-010 相当のフラット形式）を追加し、未捕捉例外が HTML 500 や無構造ログに落ちないようにした。`ops-chat-post-failures` メトリクスは特定文言限定だったため `severity=ERROR` 全体を拾うよう `docs/runbook/monitoring-setup.md` を修正
- **health-report の冪等性**: 予約確保後・Chat 投稿前にプロセスが死ぬとその日の報告が永久欠落する穴があったため、`STALE_CLAIM_MS`（10分）を超えて `postedAt` が無い予約は再クレーム可能にした
- **テスト**: `FirestoreDedupStore`（本番実装）が `InMemoryDedupStore`（テスト専用の別実装）の陰でカバレッジ0%だった（2つの独立レビューが収束して指摘）ため、`FakeFirestore` に `.where()` と真の部分マージ `update()` を実装し、`FirestoreDedupStore` を直接検証するテストを追加

## 既知の限界

- Firestore を使った集約(dedup)の実際の並行動作は、pure 関数のユニットテストと Firestore トランザクションの atomicity という信頼できるプリミティブへの委譲で担保しており、本番相当の高並行負荷での実機検証はしていない。
- `docs/runbook/monitoring-setup.md` の既存記述に `service_name=lms-api` という古い Cloud Run サービス名の参照があったため、本 ADR の実装に合わせて `service_name=api` へ修正した（別件の doc drift）。
- `GoogleOidcTokenVerifier`（google-auth-library を直接使う本番実装クラス）は単体テストでは常にモック verifier に差し替えられており、実クラス自体は未検証（`services/api/src/services/dispatch/oidc-verify.ts` の既存実装も同様の慣行のため、本PR固有の後退ではない）。
- rollback のウィンドウ境界復元は「rollback対象がそのウィンドウを開始した本人だった」ケースに対応しているが、複数のrollbackが同一fingerprintに対してほぼ同時に発生する多重障害シナリオまでは検証していない。
- **health-report の claim 解除は ownership-safe ではない**（codex review 4巡目指摘、P2）: 最初の呼び出しが `STALE_CLAIM_MS`（10分）を超えて実行中に別の Scheduler リトライが stale 判定で claim を奪い、その後に元の呼び出しが transient 失敗して無条件 delete を実行すると、新しいリトライの claim を誤って消しうる。対処は `claimedAt`（またはリーストークン）が自分の claim と一致する場合のみ削除するトランザクション化が必要だが、発生確率が低い（同一日次ジョブの実行が10分を超えて重複する必要がある）ため今回は見送った。
- **flush-job は同時配信で重複投稿しうる**（codex review 4巡目指摘、P2）: Cloud Scheduler の at-least-once 配信で flush ジョブの複数実行が重なった場合、両方が同じ pending item を読んで投稿してしまう可能性がある（`markFlushed` の条件付き削除は「新しいウィンドウとの競合」は防ぐが「同一ウィンドウの同時 flush」は防がない）。対処は投稿前にトランザクションでリース/ステータスを取得する必要があるが、flush ジョブは10分毎の低頻度実行かつ実行時間も短いため同時実行の実発生確率は低く、今回は見送った。両者とも「まれに二重通知（無害）または稀な取りこぼし」に留まり、既存の「本番相当の高並行負荷は未検証」という限界の一部として扱う。

## 2026-09-02 追記: provisioning 実施・実機検証で判明した事項

`docs/runbook/monitoring-setup.md` §6.2/§6.3 の GCP リソース provisioning を全項目実施し、実機検証（合成エラーログの publish、日次ヘルスチェックの手動実行、Uptime Check の疑似障害化）を行った。以下が判明・対応済み:

- **DLQ 転送用 IAM binding が runbook 未記載だった**: `gcloud pubsub subscriptions create --dead-letter-topic=...` は非対話実行時、Pub/Sub サービスエージェントへの DLQ topic `pubsub.publisher` / 元 subscription `pubsub.subscriber` 権限を自動付与しない。付与しないと恒久失敗イベントが DLQ へ転送されず静かに失われる。runbook に追記済み。
- **経路1（可用性監視）の当初設計は実質機能しなかった**: 5xx エラー率条件のみのアラートポリシーに Uptime Check 失敗条件を追加したが、初回実装（`ALIGN_FRACTION_TRUE`、20分ウィンドウ、拠点ごと独立評価）を実際に Uptime Check の path を疑似的に無効化して検証したところ、約47分待っても発火・Chat投稿を確認できなかった。`ALIGN_NEXT_OLDER`（直近1サンプル、BOOL型のまま） + `REDUCE_COUNT_FALSE`（6拠点横断で失敗拠点数を合算） + 過半数拠点閾値（`COMPARISON_GT`, `thresholdValue: 3`）+ ウィンドウ5分へ再設計した。
- **可用性監視、真の原因は集約設計ではなく IAM 権限不足だった**: 上記の再設計後も2回目の実機検証（07:43〜08:20 UTC）で30分間メトリクスが閾値を大幅に超過し続けたにもかかわらず発火が確認できなかったため、`mcp__codex__codex` にセカンドオピニオンを依頼した。指摘により、Gmail で実際にはメール通知チャネル（`System Admin Email`）には正しくアラートが届いていたことが判明（インシデント自体は最初から正常に発火していた）。真因は **Pub/Sub 通知チャネル用の topic（`ops-availability-alerts`）の IAM ポリシーが完全に空で、Cloud Monitoring 通知サービス自身のサービスエージェント（`service-<PROJECT_NUMBER>@gcp-sa-monitoring-notification.iam.gserviceaccount.com`）に `roles/pubsub.publisher` が一度も付与されていなかったこと**。`gcloud beta monitoring channels create --type=pubsub` は対象 topic への publish 権限を自動付与しない。付与後の3回目の実機検証で、疑似障害注入から約5分でPub/Sub配信・Chat投稿まで到達したことを確認し、**可用性監視（経路1）は最終的にエンドツーエンドで実証済み**となった。教訓: Pub/Sub 型の Monitoring 通知チャネルを作る際は、集約ロジック（aligner/reducer）だけでなく **通知サービスエージェントへの topic IAM 付与を必ずセットで確認する**（`docs/runbook/monitoring-setup.md` §6.2 に追記済み）。
- **dedup集約とflushの実機確認、完全成功**: 同一fingerprintの合成`ReportedErrorEvent`を3件連投したところ Chat 投稿は1件のみに正しく抑制され、Firestore の集約ドキュメント（`suppressedCount: 2`）も期待通りだった。10分毎の Cloud Scheduler flush ジョブ（`ops-notification-flush`）は手動トリガー不要で自動実行され、ウィンドウ終了後に抑制件数サマリー（「🔁 集約サマリー」「直近ウィンドウで2件抑制されました」）を正しく Chat へ投稿した。
- **ヘルスチェック投稿の非エンジニア可読性**: 実機投稿（`firestore: ok`, `heapUsed: 115MB`）を Chat スペースの非エンジニアメンバーも見ることが判明し、平常時は専門用語・生メトリクスを含まない一文（「LMS は正常に稼働しています」）のみに変更、異常時のみ平易な言い換え + 技術的補足を併記する設計に修正した（`chat-payload-allowlist.ts` `buildHealthReportText`）。
- **合成エラーログ publish は本番 Cloud Logging を経由しない**: エラー通知経路の実機検証は、Sink 経由ではなく `ops-error-alerts` topic への直接 publish で行った（本番 api に故意のエラーを起こさないため）。Sink フィルタ自体（`jsonPayload."@type"` の一致）はソースコード直接確認（`error-handler.ts`）で代替検証し、実ログでの一致確認はできていない（本番でエラーが実際に発生していなかったため、既知の限界として残る）。
