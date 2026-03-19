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
- **Notification**: メール or Slack webhook

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
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=lms-api" \
  --limit=50 --project=lms-279 --format=json

# エラーのみ
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=lms-api AND severity>=ERROR" \
  --limit=20 --project=lms-279
```

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
