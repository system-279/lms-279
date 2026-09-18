# 配信結果 Google Chat 通知セットアップ手順書（PR3、配信可視化）

## 概要

完了通知レーン / 進捗レポートレーンの配信結果（テナント名＋件数、氏名・メールアドレスは含まない）を
Google Chat スペースへ通知する機能の GCP リソース provisioning 手順。実装（`services/api/src/services/dispatch/chat-notify.ts`）
とルーティング（`services/api/src/index.ts`）は本 PR でマージ済みだが、**Secret Manager への webhook URL 投入と
IAM 権限付与は開発者が個別に実施する**（コミット時点では未実施）。

`docs/runbook/monitoring-setup.md` §6（ADR-042 運用通知）と同型の provisioning。ただし本機能は
`services/api`（既存の Cloud Run サービス、専用ランタイム SA なし・default compute SA で稼働）に
組み込まれているため、新規 SA 作成は不要。

**未実施でも api の起動・配信自体は失敗しない**（chat-notify.ts の `postToChat` は Secret 取得失敗時も
throw せず `{ok:false}` を返すのみ、silent degrade。ただし気づかずに放置すると「投稿されない」ことに
誰も気づけない事故と同種のリスクがある — コミット `56c72f4`「可用性アラート未発火の真因を IAM 権限不足と
特定」参照）。**本手順の最後に必ずステージング/本番で実際に投稿されることを確認すること。**

## 1. Secret 作成 + webhook URL 投入

2 レーン分の Secret を作成する（テナント名にも `maskPii` 相当のマスクを適用したうえで投稿するが、
Chat スペース自体への投稿権限は webhook URL を知っている者に限られるため、Secret 自体の管理は厳格に行う）。

```bash
gcloud secrets create dispatch-completion-notification-chat-webhook-url \
  --replication-policy=automatic --project=lms-279
gcloud secrets create dispatch-progress-report-chat-webhook-url \
  --replication-policy=automatic --project=lms-279

# webhook URL の投入は開発者自身が対話的に実施する。会話・ログ・コミットに値を残さない。
# gcloud secrets versions add dispatch-completion-notification-chat-webhook-url --data-file=- --project=lms-279
# gcloud secrets versions add dispatch-progress-report-chat-webhook-url --data-file=- --project=lms-279
```

## 2. IAM 権限付与（api 実行 SA への secretAccessor）

`api` は専用ランタイム SA を持たず default compute SA で稼働する。project number を確認してから付与する。

```bash
PROJECT_NUMBER=$(gcloud projects describe lms-279 --format='value(projectNumber)')
API_RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

gcloud secrets add-iam-policy-binding dispatch-completion-notification-chat-webhook-url \
  --member="serviceAccount:${API_RUNTIME_SA}" \
  --role="roles/secretmanager.secretAccessor" --project=lms-279
gcloud secrets add-iam-policy-binding dispatch-progress-report-chat-webhook-url \
  --member="serviceAccount:${API_RUNTIME_SA}" \
  --role="roles/secretmanager.secretAccessor" --project=lms-279
```

## 3. デプロイ

`.github/workflows/deploy.yml` の `deploy-api` job には既に以下の env var が組み込み済み（本 PR でマージ済み、追加作業不要）:

```
DISPATCH_COMPLETION_NOTIFICATION_CHAT_WEBHOOK_SECRET_NAME=projects/lms-279/secrets/dispatch-completion-notification-chat-webhook-url/versions/latest
DISPATCH_PROGRESS_REPORT_CHAT_WEBHOOK_SECRET_NAME=projects/lms-279/secrets/dispatch-progress-report-chat-webhook-url/versions/latest
```

§1・§2 実施後、次回 `main` へのデプロイ（または手動 workflow_dispatch）で反映される。

## 4. 動作確認（IAM 未付与時の挙動も含めて確認する）

1. **IAM 付与前**の状態で内部エンドポイントを手動トリガーし、Chat スペースへ投稿されないこと・
   `services/api` のログに `dispatch chat webhook URL の取得に失敗しました` が出ることを確認する
   （§2 未実施の状態を意図的に再現し、silent degrade の実際の挙動を確認する）。
2. §1・§2 を実施したうえで再度トリガーし、Chat スペースにテナント名＋件数が投稿されることを確認する。
3. 投稿内容に受講者の氏名・メールアドレスが含まれていないことを目視確認する。

## 参考

- 実装: `services/api/src/services/dispatch/chat-notify.ts`
- ADR: `docs/adr/ADR-042-ops-chat-notification.md`（配置決定の適用範囲に関する追記あり）/ `docs/adr/ADR-039-phase3-progress-report-dispatch.md`
- 類似 provisioning: `docs/runbook/monitoring-setup.md` §6
