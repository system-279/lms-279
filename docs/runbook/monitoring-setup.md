# 監視セットアップ手順書

## 概要
Cloud Monitoring + Cloud Error Reporting による本番監視の設定手順。

## 1. アップタイムチェック

### API ヘルスチェック
```bash
gcloud monitoring uptime create \
  --display-name="LMS API Health" \
  --resource-type=uptime-url \
  --monitored-resource="host=api-YOUR_DOMAIN" \
  --path="/health" \
  --check-interval=60s \
  --timeout=10s \
  --project=lms-279
```

### Readiness チェック
```bash
gcloud monitoring uptime create \
  --display-name="LMS API Readiness" \
  --resource-type=uptime-url \
  --monitored-resource="host=api-YOUR_DOMAIN" \
  --path="/health/ready" \
  --check-interval=300s \
  --timeout=30s \
  --project=lms-279
```

## 2. アラートポリシー

### 5xx エラー率アラート（Cloud Run）
コンソール: Monitoring > Alerting > Create Policy

- **Condition**: Cloud Run > Request count, filter by response_code_class="5xx"
- **Threshold**: 5件/5分
- **Notification**: メール、または Pub/Sub 通知チャネル経由で Google Chat（§6 参照、ADR-042）

### 手動設定（gcloud）
```bash
# アラートポリシー作成（JSON定義）
cat > /tmp/alert-policy.json << 'POLICY'
{
  "displayName": "LMS API 5xx Error Rate",
  "conditions": [{
    "displayName": "5xx errors > 5 in 5min",
    "conditionThreshold": {
      "filter": "resource.type=\"cloud_run_revision\" AND metric.type=\"run.googleapis.com/request_count\" AND metric.labels.response_code_class=\"5xx\"",
      "comparison": "COMPARISON_GT",
      "thresholdValue": 5,
      "duration": "300s",
      "aggregations": [{
        "alignmentPeriod": "300s",
        "perSeriesAligner": "ALIGN_SUM"
      }]
    }
  }],
  "combiner": "OR",
  "notificationChannels": []
}
POLICY

gcloud alpha monitoring policies create \
  --policy-from-file=/tmp/alert-policy.json \
  --project=lms-279
```

## 3. Cloud Error Reporting

自動的に有効。APIのエラーハンドラが以下の形式でログ出力するため、Cloud Error Reportingが自動検出する:

```json
{
  "severity": "ERROR",
  "@type": "type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent",
  "message": "Error message",
  "error": { "name": "Error", "message": "...", "stack": "..." }
}
```

確認: Console > Error Reporting

## 4. Cloud Run ログ確認

```bash
# 最新ログ
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=api" \
  --limit=50 --project=lms-279 --format=json

# エラーのみ
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=api AND severity>=ERROR" \
  --limit=20 --project=lms-279
```

> **2026-09-02 修正**: Cloud Run サービス名は `api`（`deploy.yml` の `gcloud run deploy api`）。旧記述の
> `service_name=lms-api` は実在しないサービス名を参照していた doc drift のため修正した
> （ADR-042 運用通知自動化のクロスレビューで判明）。

## 5. Cloud Run liveness/readiness プローブ設定

`cloud-run-service.yaml` または deploy コマンドで設定:

```yaml
spec:
  template:
    spec:
      containers:
        - image: ...
          livenessProbe:
            httpGet:
              path: /health
            initialDelaySeconds: 5
            periodSeconds: 10
          startupProbe:
            httpGet:
              path: /health/ready
            initialDelaySeconds: 10
            periodSeconds: 10
            failureThreshold: 3
```

## 6. 運用通知の自動化（Google Chat 連携、ADR-042）

`services/notification` が Google Chat の受信 Webhook（Secret Manager 管理）へ、平日毎日のヘルスチェック結果とエラー発生時の詳細を投稿する。実装は PR でマージ済みだが、以下の GCP リソース provisioning は**開発者の gcloud 認証回復後、コード外で個別に実施**する（コミット時点では未実施）。すべて冪等なコマンドとして記載し、実行後は `describe` で実在確認すること。

**実施順序が重要**（先に SA を作らずに `deploy.yml` の `--service-account` を有効化すると Cloud Run デプロイが失敗する）:

### 6.1 PR マージ前（bootstrap）

```bash
# 専用ランタイム SA
gcloud iam service-accounts create notification-runtime \
  --display-name="notification service runtime SA" --project=lms-279

# IAM（最小権限）
gcloud secrets add-iam-policy-binding ops-chat-webhook-url \
  --member="serviceAccount:notification-runtime@lms-279.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor" --project=lms-279
gcloud projects add-iam-policy-binding lms-279 \
  --member="serviceAccount:notification-runtime@lms-279.iam.gserviceaccount.com" \
  --role="roles/datastore.user"

# Secret 作成（Webhook URL の投入は開発者自身が実施。会話・ログ・コミットに値を残さない）
gcloud secrets create ops-chat-webhook-url --replication-policy=automatic --project=lms-279
# gcloud secrets versions add ops-chat-webhook-url --data-file=- --project=lms-279  ← 開発者が対話的に実行
```

### 6.2 マージ後（開発者の認可を得てから）

既存監視インフラの棚卸し（重複作成防止）:
```bash
gcloud monitoring uptime list-configs --project=lms-279
gcloud alpha monitoring policies list --project=lms-279
gcloud logging sinks list --project=lms-279
gcloud pubsub topics list --project=lms-279
gcloud scheduler jobs list --project=lms-279 --location=asia-northeast1
```

Sink フィルタの事前検証（作成前に実ログでヒットすることを確認）:
```bash
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="api" AND jsonPayload."@type"="type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent"' \
  --limit=5 --project=lms-279
```

Pub/Sub（DLQ付き）+ Logging Sink:
```bash
gcloud pubsub topics create ops-error-alerts --project=lms-279
gcloud pubsub topics create ops-error-alerts-dlq --project=lms-279
gcloud pubsub subscriptions create ops-error-alerts-sub \
  --topic=ops-error-alerts \
  --push-endpoint="https://<notification-cloud-run-url>/internal/error-alert" \
  --push-auth-service-account="ops-pubsub-caller@lms-279.iam.gserviceaccount.com" \
  --push-auth-token-audience="https://<notification-cloud-run-url>/internal/error-alert" \
  --dead-letter-topic=ops-error-alerts-dlq --max-delivery-attempts=5 \
  --project=lms-279

gcloud logging sinks create ops-error-alerts-sink pubsub.googleapis.com/projects/lms-279/topics/ops-error-alerts \
  --log-filter='resource.type="cloud_run_revision" AND resource.labels.service_name="api" AND jsonPayload."@type"="type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent"' \
  --project=lms-279
# sink の writer identity に Pub/Sub publish 権限を付与（sinks describe で writerIdentity を確認してから）
gcloud pubsub topics add-iam-policy-binding ops-error-alerts \
  --member="<sink writerIdentity>" --role="roles/pubsub.publisher" --project=lms-279

# Pub/Sub サービスエージェントに push 用 SA への Token Creator 権限（OIDC audience検証だけでは不足）
gcloud iam service-accounts add-iam-policy-binding ops-pubsub-caller@lms-279.iam.gserviceaccount.com \
  --member="serviceAccount:service-<PROJECT_NUMBER>@gcp-sa-pubsub.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountTokenCreator" --project=lms-279
```

Cloud Scheduler（日次ヘルスチェック + 10分毎 flush、SA は ADR-039 と共用可）:
```bash
gcloud scheduler jobs create http ops-daily-health-check \
  --schedule="0 9 * * 1-5" --time-zone="Asia/Tokyo" \
  --uri="https://<notification-cloud-run-url>/internal/health-report" --http-method=POST \
  --oidc-service-account-email="dxcollege-scheduler@lms-279.iam.gserviceaccount.com" \
  --oidc-token-audience="https://<notification-cloud-run-url>/internal/health-report" \
  --location=asia-northeast1 --project=lms-279

gcloud scheduler jobs create http ops-notification-flush \
  --schedule="*/10 * * * *" --time-zone="Asia/Tokyo" \
  --uri="https://<notification-cloud-run-url>/internal/flush" --http-method=POST \
  --oidc-service-account-email="dxcollege-scheduler@lms-279.iam.gserviceaccount.com" \
  --oidc-token-audience="https://<notification-cloud-run-url>/internal/flush" \
  --location=asia-northeast1 --project=lms-279
```

Cloud Monitoring Uptime Check + Alerting Policy（可用性監視、§1/§2 の延長。通知チャネルを Pub/Sub 経由の `notification /internal/availability-alert` に向ける）:
```bash
# §1 のコマンドで uptime check 作成後、Pub/Sub 通知チャネルを作成
gcloud pubsub topics create ops-availability-alerts --project=lms-279
gcloud pubsub subscriptions create ops-availability-alerts-sub \
  --topic=ops-availability-alerts \
  --push-endpoint="https://<notification-cloud-run-url>/internal/availability-alert" \
  --push-auth-service-account="ops-pubsub-caller@lms-279.iam.gserviceaccount.com" \
  --push-auth-token-audience="https://<notification-cloud-run-url>/internal/availability-alert" \
  --project=lms-279
gcloud beta monitoring channels create --project=lms-279 \
  --display-name="ops-chat-availability" --type=pubsub \
  --channel-labels=topic=projects/lms-279/topics/ops-availability-alerts
# §2 の alert-policy.json の notificationChannels に上記チャネルIDを設定して再作成
```

Firestore TTL 有効化（集約用ドキュメント。既存の `ttlExpireAt` 規約に合わせる）:
```bash
gcloud firestore fields ttls update ttlExpireAt \
  --collection-group=ops_notification_dedup --enable-ttl --project=lms-279
gcloud firestore fields ttls update ttlExpireAt \
  --collection-group=ops_health_report_sent --enable-ttl --project=lms-279
```

### 6.3 notification 自身の障害検知（Chat単一障害点対策）

`notification` は Sink 対象から除外しているため、Chat 投稿失敗はログベースメトリクスで拾う:
```bash
gcloud logging metrics create ops-chat-post-failures \
  --description="notification service failed to post to Chat webhook" \
  --log-filter='resource.type="cloud_run_revision" AND resource.labels.service_name="notification" AND severity="ERROR" AND jsonPayload.message=~"Chat webhook"' \
  --project=lms-279
# このメトリクスに対してメール通知チャネルのアラートポリシーを作成する（§2 手動設定と同様の手順）
```
