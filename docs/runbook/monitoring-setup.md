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

### 5xx エラー率アラート（Cloud Run）+ Uptime Check 失敗アラート
コンソール: Monitoring > Alerting > Create Policy

- **Condition 1**: Cloud Run > Request count, filter by response_code_class="5xx"
- **Threshold**: 5件/5分
- **Condition 2/3**: Uptime Check（`LMS API Health` / `LMS API Readiness`）で、直近5分の最新サンプルにおいて6拠点中4拠点以上（過半数）が失敗（可用性監視、経路1。5xx条件だけでは「リクエストすら来ない＝ログも出ない」障害を検知できないため、2026-09-02 追記で `combiner: OR` の別条件として追加。ADR-042 経路1の設計意図を満たすための拡張。**2026-09-02 実機検証で判明した再設計**: 当初は `ALIGN_FRACTION_TRUE`（20分ウィンドウ、拠点ごと独立評価）だったが、実際にUptime Checkを疑似障害化して検証したところ約47分待っても発火せず、検知が遅すぎることが判明。`ALIGN_NEXT_OLDER`（直近1サンプル） + `REDUCE_COUNT_FALSE`（拠点横断で失敗数を合算）+ 過半数拠点閾値へ変更し、ウィンドウを5分に短縮。単一拠点の一時的ネットワーク不調による誤検知にも強くなる副次効果あり）
- **Notification**: メール、および Pub/Sub 通知チャネル経由で Google Chat（§6 参照、ADR-042）

### 手動設定（gcloud）

`<uptime-check-id>` は `gcloud monitoring uptime list-configs --project=lms-279` で確認する（§1 のコマンドで作成した2件の `name` 末尾）。

```bash
# アラートポリシー作成（JSON定義）
cat > /tmp/alert-policy.json << 'POLICY'
{
  "displayName": "LMS API 5xx Error Rate",
  "conditions": [
    {
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
    },
    {
      "displayName": "Uptime check failing: LMS API Health (majority of locations)",
      "conditionThreshold": {
        "filter": "resource.type=\"uptime_url\" AND metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND metric.labels.check_id=\"<uptime-check-id-health>\"",
        "comparison": "COMPARISON_GT",
        "thresholdValue": 3,
        "duration": "0s",
        "aggregations": [{
          "alignmentPeriod": "300s",
          "perSeriesAligner": "ALIGN_NEXT_OLDER",
          "crossSeriesReducer": "REDUCE_COUNT_FALSE",
          "groupByFields": ["resource.label.host", "resource.label.project_id"]
        }]
      }
    },
    {
      "displayName": "Uptime check failing: LMS API Readiness (majority of locations)",
      "conditionThreshold": {
        "filter": "resource.type=\"uptime_url\" AND metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND metric.labels.check_id=\"<uptime-check-id-readiness>\"",
        "comparison": "COMPARISON_GT",
        "thresholdValue": 3,
        "duration": "0s",
        "aggregations": [{
          "alignmentPeriod": "300s",
          "perSeriesAligner": "ALIGN_NEXT_OLDER",
          "crossSeriesReducer": "REDUCE_COUNT_FALSE",
          "groupByFields": ["resource.label.host", "resource.label.project_id"]
        }]
      }
    }
  ],
  "combiner": "OR",
  "notificationChannels": []
}
POLICY

gcloud alpha monitoring policies create \
  --policy-from-file=/tmp/alert-policy.json \
  --project=lms-279
```

> **`ALIGN_NEXT_OLDER` + `REDUCE_COUNT_FALSE` を使う（`ALIGN_FRACTION_TRUE` は使わない）**: `ALIGN_FRACTION_TRUE`
> は BOOL の `check_passed` を DOUBLE（0.0〜1.0の割合）へ変換するため、その後に `REDUCE_COUNT_FALSE`（BOOL専用）を
> 組み合わせると `INVALID_ARGUMENT` になる。`ALIGN_NEXT_OLDER` は BOOL 型のまま「直近1サンプルの値」を採るため、
> 後段で `REDUCE_COUNT_FALSE`（6拠点中いくつが `false` か）を組み合わせられる。標準的なUptime Check多拠点集約の
> 定石パターン（デフォルトのDouble変換系aligner + crossSeriesReducerの組み合わせは型不一致で軒並み使えない）。
>
> **thresholdValue は「拠点数」の絶対値**（割合ではない）。デフォルトの世界6拠点構成
> （usa-virginia/usa-oregon/usa-iowa/eur-belgium/apac-singapore/sa-brazil-sao_paulo）を前提に、
> 過半数（4拠点以上）が同時に失敗した場合のみ発火するよう `COMPARISON_GT` + `thresholdValue: 3` とした。
> 拠点数が変わった場合は再計算すること。

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

`services/notification` が Google Chat の受信 Webhook（Secret Manager 管理）へ、平日毎日のヘルスチェック結果とエラー発生時の詳細を投稿する。以下の GCP リソース provisioning は**開発者の gcloud 認証回復後、コード外で個別に実施**する（コミット時点では未実施）。すべて冪等なコマンドとして記載し、実行後は `describe` で実在確認すること。

**実装コードと `deploy.yml` の結線は別PRに分離している**（codex review 3巡目指摘: `notification-runtime` SA が存在しない状態で `deploy.yml` に `--service-account` 参照を含めて main へマージすると、次の push で `deploy-notification` job が失敗する）。進め方: ①本PR（実装コード + テスト。`deploy.yml` は現状の `--no-allow-unauthenticated` のみで変更なし）をマージ → ②6.1 の bootstrap を実施 → ③ `deploy.yml` に `--service-account` / `OPS_*` env-vars を追加する follow-up PR を作成・マージ → ④6.2 以降を実施。

**実施順序が重要**（先に SA を作らずに `deploy.yml` の `--service-account` を有効化すると Cloud Run デプロイが失敗する）:

### 6.1 PR マージ前（bootstrap）

```bash
# 専用ランタイム SA
gcloud iam service-accounts create notification-runtime \
  --display-name="notification service runtime SA" --project=lms-279

# Secret 作成（IAM binding より先に作成する必要がある。順序を誤ると
# add-iam-policy-binding が NOT_FOUND で失敗する。codex review 指摘）。
# Webhook URL の投入は開発者自身が実施。会話・ログ・コミットに値を残さない。
gcloud secrets create ops-chat-webhook-url --replication-policy=automatic --project=lms-279
# gcloud secrets versions add ops-chat-webhook-url --data-file=- --project=lms-279  ← 開発者が対話的に実行

# IAM（最小権限）
gcloud secrets add-iam-policy-binding ops-chat-webhook-url \
  --member="serviceAccount:notification-runtime@lms-279.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor" --project=lms-279
gcloud projects add-iam-policy-binding lms-279 \
  --member="serviceAccount:notification-runtime@lms-279.iam.gserviceaccount.com" \
  --role="roles/datastore.user"

# Pub/Sub push 用の呼び出し元 SA（6.2 で push subscription の認証に使う。
# notification-runtime とは別。呼び出し元の身元と実行時の身元を分離するため）
gcloud iam service-accounts create ops-pubsub-caller \
  --display-name="Pub/Sub push caller for ops notification" --project=lms-279

# 両呼び出し元（Cloud Scheduler の既存 SA と ops-pubsub-caller）に、
# notification は --no-allow-unauthenticated のため Cloud Run Invoker が必須
# （IAM レベルの認可はミドルウェアの OIDC 検証より手前で効く。codex review 指摘）。
# <notification-cloud-run-url> が確定するのは初回デプロイ後のため、この2行は
# 6.2 の一番最初（初回デプロイ後・他リソース作成前）に実行する。
# gcloud run services add-iam-policy-binding notification \
#   --region=asia-northeast1 --project=lms-279 \
#   --member="serviceAccount:dxcollege-scheduler@lms-279.iam.gserviceaccount.com" \
#   --role="roles/run.invoker"
# gcloud run services add-iam-policy-binding notification \
#   --region=asia-northeast1 --project=lms-279 \
#   --member="serviceAccount:ops-pubsub-caller@lms-279.iam.gserviceaccount.com" \
#   --role="roles/run.invoker"
```

### 6.2 マージ後（開発者の認可を得てから）

> **2026-09-02 実施済み**: 本節（6.2）・6.3 は Claude Code + `gcloud` で全項目実施・実機確認済み
> （PR #686 マージ後の初回デプロイ成功を確認してから着手）。実行時に判明した runbook 未記載の
> 差分（DLQ 転送用 IAM binding が `--dead-letter-topic` 指定だけでは自動付与されない、経路1の
> アラートポリシーが 5xx 条件のみで Uptime Check 失敗自体には未接続だった設計ギャップ）は
> 本節のコマンド例・§2 に反映済み。

`NOTIFICATION_BASE_URL` は `notification` の Cloud Run サービス URL（`gcloud run services describe notification --region=asia-northeast1 --project=lms-279 --format='value(status.url)'` で取得）。
**OIDC audience は常にこの base URL を使う**（パス毎に分けない。Cloud Scheduler / Pub/Sub push が発行する ID Token の `aud` は `--oidc-token-audience` / `--push-auth-token-audience` で指定した値そのものになり、`OPS_SCHEDULER_AUDIENCE` / `OPS_PUBSUB_AUDIENCE`（`deploy.yml`、base URL のみを設定）と一致しないと 401 になる。既存の `DISPATCH_OIDC_AUDIENCE` と同じ慣例、codex review 指摘）:
```bash
NOTIFICATION_BASE_URL=$(gcloud run services describe notification \
  --region=asia-northeast1 --project=lms-279 --format='value(status.url)')

# Cloud Run Invoker（6.1 末尾を参照、初回デプロイ後にここで実行）
gcloud run services add-iam-policy-binding notification \
  --region=asia-northeast1 --project=lms-279 \
  --member="serviceAccount:dxcollege-scheduler@lms-279.iam.gserviceaccount.com" \
  --role="roles/run.invoker"
gcloud run services add-iam-policy-binding notification \
  --region=asia-northeast1 --project=lms-279 \
  --member="serviceAccount:ops-pubsub-caller@lms-279.iam.gserviceaccount.com" \
  --role="roles/run.invoker"
```

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
  --push-endpoint="${NOTIFICATION_BASE_URL}/internal/error-alert" \
  --push-auth-service-account="ops-pubsub-caller@lms-279.iam.gserviceaccount.com" \
  --push-auth-token-audience="${NOTIFICATION_BASE_URL}" \
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

# DLQ 転送権限（2026-09-02 実施時に判明した必須ステップ。--dead-letter-topic 付き
# subscription 作成コマンド自体は非対話実行時にこの権限を自動付与しないため、
# 明示的に付与しないと恒久失敗イベントが DLQ へ転送されず静かに失われる）:
gcloud pubsub topics add-iam-policy-binding ops-error-alerts-dlq \
  --member="serviceAccount:service-<PROJECT_NUMBER>@gcp-sa-pubsub.iam.gserviceaccount.com" \
  --role="roles/pubsub.publisher" --project=lms-279
gcloud pubsub subscriptions add-iam-policy-binding ops-error-alerts-sub \
  --member="serviceAccount:service-<PROJECT_NUMBER>@gcp-sa-pubsub.iam.gserviceaccount.com" \
  --role="roles/pubsub.subscriber" --project=lms-279
```

Cloud Scheduler（日次ヘルスチェック + 10分毎 flush、SA は ADR-039 と共用可）:
```bash
gcloud scheduler jobs create http ops-daily-health-check \
  --schedule="0 9 * * 1-5" --time-zone="Asia/Tokyo" \
  --uri="${NOTIFICATION_BASE_URL}/internal/health-report" --http-method=POST \
  --oidc-service-account-email="dxcollege-scheduler@lms-279.iam.gserviceaccount.com" \
  --oidc-token-audience="${NOTIFICATION_BASE_URL}" \
  --location=asia-northeast1 --project=lms-279

gcloud scheduler jobs create http ops-notification-flush \
  --schedule="*/10 * * * *" --time-zone="Asia/Tokyo" \
  --uri="${NOTIFICATION_BASE_URL}/internal/flush" --http-method=POST \
  --oidc-service-account-email="dxcollege-scheduler@lms-279.iam.gserviceaccount.com" \
  --oidc-token-audience="${NOTIFICATION_BASE_URL}" \
  --location=asia-northeast1 --project=lms-279
```

Cloud Monitoring Uptime Check + Alerting Policy（可用性監視、§1/§2 の延長。通知チャネルを Pub/Sub 経由の `notification /internal/availability-alert` に向ける）:
```bash
# §1 のコマンドで uptime check 作成後、Pub/Sub 通知チャネルを作成
gcloud pubsub topics create ops-availability-alerts --project=lms-279
gcloud pubsub topics create ops-availability-alerts-dlq --project=lms-279
gcloud pubsub subscriptions create ops-availability-alerts-sub \
  --topic=ops-availability-alerts \
  --push-endpoint="${NOTIFICATION_BASE_URL}/internal/availability-alert" \
  --push-auth-service-account="ops-pubsub-caller@lms-279.iam.gserviceaccount.com" \
  --push-auth-token-audience="${NOTIFICATION_BASE_URL}" \
  --dead-letter-topic=ops-availability-alerts-dlq --max-delivery-attempts=5 \
  --project=lms-279

# DLQ 転送権限（ops-error-alerts と同様、必須）
gcloud pubsub topics add-iam-policy-binding ops-availability-alerts-dlq \
  --member="serviceAccount:service-<PROJECT_NUMBER>@gcp-sa-pubsub.iam.gserviceaccount.com" \
  --role="roles/pubsub.publisher" --project=lms-279
gcloud pubsub subscriptions add-iam-policy-binding ops-availability-alerts-sub \
  --member="serviceAccount:service-<PROJECT_NUMBER>@gcp-sa-pubsub.iam.gserviceaccount.com" \
  --role="roles/pubsub.subscriber" --project=lms-279

gcloud beta monitoring channels create --project=lms-279 \
  --display-name="ops-chat-availability" --type=pubsub \
  --channel-labels=topic=projects/lms-279/topics/ops-availability-alerts
# §2 のポリシーへ、既存チャネルを維持したまま追加する（再作成ではなく追加。
# 既存の 5xx 条件・メールチャネルを消さないため --add-notification-channels を使う）:
gcloud alpha monitoring policies update <alert-policy-name> \
  --add-notification-channels=<pubsub channel name> --project=lms-279
```

Firestore TTL 有効化（集約用ドキュメント。既存の `ttlExpireAt` 規約に合わせる）:
```bash
gcloud firestore fields ttls update ttlExpireAt \
  --collection-group=ops_notification_dedup --enable-ttl --project=lms-279
gcloud firestore fields ttls update ttlExpireAt \
  --collection-group=ops_health_report_sent --enable-ttl --project=lms-279
```

### 6.3 notification 自身の障害検知（Chat単一障害点対策）

`notification` は Sink 対象から除外しているため、`notification` 自身の障害はログベースメトリクスで拾う。
**フィルタは `jsonPayload.message=~"Chat webhook"` のような特定文言限定にせず、severity=ERROR
全体を対象にする**（pr-review-toolkit silent-failure-hunter 指摘: dedup transaction のリトライ枯渇・
rollback失敗・Pub/Subデコード失敗・OIDC検証失敗等、Chat投稿以外の失敗ログも拾わないと、
通知パイプラインの入口（認証層）や集約ロジックが壊れていても誰も気づけない）:
```bash
gcloud logging metrics create ops-notification-errors \
  --description="notification service internal errors (Chat post failures, dedup/rollback failures, decode failures, OIDC verification failures, etc.)" \
  --log-filter='resource.type="cloud_run_revision" AND resource.labels.service_name="notification" AND severity="ERROR"' \
  --project=lms-279
# このメトリクスに対してメール通知チャネルのアラートポリシーを作成する（§2 手動設定と同様の手順）
```
