# カスタムドメイン設定手順

## 概要
Cloud Runサービスにカスタムドメインをマッピングする手順。

## 前提条件
- ドメインの所有権が確認済み
- Cloud Runサービスがデプロイ済み

## 手順

### 1. ドメイン所有権の確認
```bash
gcloud domains verify YOUR_DOMAIN --project=lms-279
```

### 2. Cloud Runサービスにドメインマッピング

#### API サービス
```bash
gcloud run domain-mappings create \
  --service=lms-api \
  --domain=api.YOUR_DOMAIN \
  --region=asia-northeast1 \
  --project=lms-279
```

#### Web サービス
```bash
gcloud run domain-mappings create \
  --service=lms-web \
  --domain=YOUR_DOMAIN \
  --region=asia-northeast1 \
  --project=lms-279
```

### 3. DNS レコード設定
上記コマンドの出力に表示されるDNSレコードをドメインプロバイダに設定:

| タイプ | 名前 | 値 |
|--------|------|-----|
| CNAME | api | ghs.googlehosted.com. |
| CNAME | @ | ghs.googlehosted.com. |

※ Aレコードが必要な場合もあり（出力に従う）

### 4. SSL証明書の確認
Cloud Runが自動でマネージドSSL証明書を発行。反映まで最大24時間。

```bash
gcloud run domain-mappings describe \
  --domain=YOUR_DOMAIN \
  --region=asia-northeast1 \
  --project=lms-279
```

### 5. 環境変数の更新
カスタムドメイン設定後、以下の環境変数を更新:

```bash
# API サービス
gcloud run services update lms-api \
  --set-env-vars="CORS_ORIGIN=https://YOUR_DOMAIN" \
  --region=asia-northeast1

# Web サービス
gcloud run services update lms-web \
  --set-env-vars="API_URL=https://api.YOUR_DOMAIN" \
  --region=asia-northeast1
```

## トラブルシューティング

| 症状 | 原因 | 対策 |
|------|------|------|
| SSL証明書が発行されない | DNS未伝搬 | 24時間待つ、DNSレコード再確認 |
| 502エラー | CORSミスマッチ | CORS_ORIGIN環境変数確認 |
| リダイレクトループ | HTTP→HTTPSリダイレクト設定 | Cloud Run側でHTTPS強制設定確認 |
