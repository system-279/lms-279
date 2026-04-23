# Runbook: OAuth 同意画面の External 化 + Publish

Issue #272 Phase 1.1 の作業手順書。`279279.net` Workspace 組織外のユーザー（例: `sayori-maeda@kanjikai.or.jp`）が Google ログインできない `403 org_internal` を解消する。

## 方針（2026-04-23 PM/PL 確認済、Codex セカンドオピニオン裏取り）

- **原則 Production Publish**（本 runbook §2）。basic scopes のみで Google Trust & Safety 審査不要、Publish 即時反映。
- **Testing モードは暫定策としてのみ使用**（Publish が詰まった場合、または 1 名限定の緊急時）。Testing は 100 ユーザー上限で、外部ドメイン追加のたびに test user 登録運用が発生するため持続不能。
- **Authorized Domains（§3）はメールドメイン制御ではない**。`kanjikai.or.jp` 等のユーザーメールドメインを追加する必要はない。登録すべきは Cloud Run / カスタムドメイン等のアプリ配信ドメインのみ。
- 本作業の前提として [tenant-and-allowlist-preflight-check.md](./tenant-and-allowlist-preflight-check.md) でテナント存在と `allowed_emails` 登録を確認しておくこと。OAuth を開けてもアプリ側で `403 tenant_access_denied` で止まる。

## 前提

- **GCP Project**: `lms-279`
- **Firebase Project**: `lms-279`（同プロジェクト）
- **AUTH_MODE**: `firebase`（本番）
- **使用 scope**: `openid` / `email` / `profile` のみ（Firebase Auth の Google サインイン標準）
- **DWD 経由の sensitive scopes**（`drive` / `docs` / `sheets`）は Service Account 認証で OAuth 同意画面を経由しないため、この作業の影響範囲外

## 審査の有無

**basic scopes のみ → Google の Trust & Safety 審査は不要。Publish ボタンを押した瞬間に Production 状態になる。**

将来 DWD 経由ではなくエンドユーザーに直接 sensitive scopes を要求する方向に変更した場合、その時点で審査が必要になる（所要: 数日〜数週間）。

## 作業ステップ

### 1. OAuth 同意画面を External に切り替え

1. GCP Console → `APIs & Services` → `OAuth consent screen` を開く
   - URL: https://console.cloud.google.com/apis/credentials/consent?project=lms-279
2. 現在の `User Type` が `Internal` であることを確認
3. `Make External` または `User Type: External` に変更
4. 以下の必須項目を埋める（未入力ならエラーになる）
   - App name: `LMS-279`（任意の表示名）
   - User support email: 運用担当のメールアドレス
   - App logo: 任意（未設定でも Publish 可能）
   - Application home page: Cloud Run の URL または `https://lms-279.example.com`
   - Application privacy policy: 社内規程ページ URL（なければ暫定 URL でも可）
   - Application terms of service: 同上
   - Authorized domains: `lms-279.example.com` 等（Firebase Auth Authorized Domains と一致させる）
   - Developer contact information: 運用担当のメールアドレス
5. **Scope セクションは一切触らない**（`openid` / `email` / `profile` のまま。追加すると審査対象化するリスク）
6. `Save and Continue` で次ステップへ

### 2. Publish（Production 化）

1. 画面上部の `Publishing status` を確認（この時点では `Testing`）
2. **`Publish App`** をクリック
3. 確認ダイアログで以下を確認
   - 「Verification is not required for your app because it uses only sensitive scopes that are owned by your project」のような文言が出る
   - 「Do you want to push your app to production?」に対して `Confirm`
4. `Publishing status` が **`In production`** に変わったことを確認

### 3. Firebase Authorized Domains の確認（Phase 1.2）

Codex セカンドオピニオンでは skip 推奨だが、念のため確認のみ実施。

1. Firebase Console → `Authentication` → `Settings` → `Authorized domains`
2. 本番で使用しているドメイン（Cloud Run URL / カスタムドメイン）が登録されていることを確認
3. **ここにドメインを追加してもアクセス制御にはならない**（単に OAuth redirect を許可するだけ）
4. 変更不要であれば閉じる

### 4. 動作確認（Phase 1.4）

#### 4-1. 外部ドメインユーザーでの Google ログイン可否

1. 外部ドメインのテストアカウントを用意
   - **第一候補**: `sayori-maeda@kanjikai.or.jp` に実機確認を依頼（下記テンプレ参照）
   - 第二候補: 運用側で持っている別ドメインの Gmail 等
2. 本番 URL にアクセス → Google ログイン
3. 期待する結果
   - `403 org_internal` が出ない
   - Google 同意画面が表示される（初回のみ）
   - ログイン後、`403 tenant_access_denied` で `allowed_emails` 未登録を理由にアプリ側で弾かれる **ことが正しい状態**
4. `allowed_emails` 登録済みのテナントでログインするとダッシュボードまで到達する

#### 4-2. 既存ユーザー（`279279.net` ドメイン）への影響確認

1. 既存の管理者アカウント（`system@279279.net` 等）で再ログイン
2. 問題なくログインできることを確認
3. トークン revoke や再認証要求は発生しないはず（OAuth 設定変更は既存セッションに影響しない）

#### 4-3. サーバーログ確認

```bash
gcloud logging read \
  'resource.type="cloud_run_revision" AND severity>=WARNING' \
  --project=lms-279 \
  --limit=20 \
  --format=json \
  --freshness=1h
```

想定される新規ログ:
- `Tenant access denied` (`403 tenant_access_denied`) — **期待通り**（外部ユーザーが `allowed_emails` 未登録で弾かれた場合）
- `Firebase token verification failed` — 発生してはいけない（発生した場合は設定ミスを疑う）

### 5. sayori-maeda さんへの再ログイン依頼テンプレ

以下の文面を参考に連絡する。

```
sayori-maeda さん

先日お伝えいただいたログイン不可の件、プラットフォーム側の設定を更新しました。
お手数ですが以下の手順で再度ログインをお試しください。

1. ブラウザのキャッシュ/Cookie をクリア（または別ブラウザ/プライベートウィンドウを使用）
2. https://<本番 URL>/<tenant>/ にアクセス
3. Google ログインボタンから kanjikai.or.jp のアカウントでログイン
4. Google の「このアプリを許可しますか？」画面が出たら「許可」を選択
   （初回のみ。「確認されていないアプリ」の警告が出た場合は「詳細」→「安全ではないページに移動」で進めてください）
5. ダッシュボードが表示されれば成功

もし以下のいずれかの画面で止まった場合は、スクリーンショット付きでご連絡ください:
- 「403 org_internal」: 設定反映待ち（最大 5 分ほど待ってから再試行）
- 「アクセス権限がありません」: allowed_emails 登録漏れの可能性（こちらで追加登録します）
- その他のエラー: 認証基盤側の問題の可能性

お手数をおかけしますが、よろしくお願いいたします。
```

## ロールバック手順

外部ユーザーへの影響範囲が想定外に広い場合、以下で Internal に戻せる。

1. GCP Console → `APIs & Services` → `OAuth consent screen`
2. `Back to Testing` をクリック（Testing に戻すと外部ユーザーはログイン不可に戻る）
3. または `User Type` を `Internal` に戻す（Workspace 組織内ユーザーのみ可に戻る）

**注意**: ロールバックしても既発行の ID Token / Refresh Token は有効期限まで生き残る。完全に遮断したい場合は `allowed_emails` 側で該当ユーザーを削除（削除時に refresh token 失効、PR #277 の機能）。

## 完了判定

- [ ] GCP Console で `Publishing status: In production` が確認できた
- [ ] 既存ユーザー（`279279.net`）のログインに影響がない
- [ ] 外部ドメインユーザーが `403 org_internal` を回避できた
- [ ] sayori-maeda さんから再ログイン成功の連絡を受けた

すべてチェックが付いたら Issue #272 Phase 1 を完了として次 Phase に進む。

## 参考

- ADR-005: Firebase Authentication
- ADR-006: allowed_emails
- ADR-030 (Draft): 認証・認可・テナント解決・Workspace 連携の責務分離
- ADR-031 (Draft): GCIP マルチテナント採用
- Issue #272: [緊急対応] 外部ドメインユーザーのログイン不可への恒久対応
