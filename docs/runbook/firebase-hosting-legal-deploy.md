# Runbook: 法的文書を Firebase Hosting でデプロイ

Issue #272 緊急復旧トラックの関連作業。`lms-279.firebaseapp.com` 経由でプライバシーポリシー / 利用規約を公開し、Google Auth Platform のブランディング検証を通過させる。

## 背景

2026-04-23 Session 10 で OAuth 同意画面を External / 本番環境に切替完了後、「確認されていないアプリ」警告を抑止するため Google Auth Platform のブランディング検証を申請したい。しかし:

- 承認済みドメインは `lms-279.firebaseapp.com` のみ登録可能（`docs.google.com` 等は最上位プライベートドメインの所有権確認不可で登録不能）
- プライバシーポリシー URL / 利用規約 URL を `lms-279.firebaseapp.com` 配下に置く必要

本 runbook は Firebase Hosting で `/privacy` と `/terms` を公開する手順を定める。

## 前提

- **Firebase CLI**: `firebase --version` でインストール確認（未導入なら `npm install -g firebase-tools`）
- **Firebase ログイン**: `firebase login`（ブラウザ認証、`system@279279.net` で実施推奨）
- **プロジェクト**: `.firebaserc` の default 設定で `lms-279` を指定済み

## ファイル構成

```
lms/
├── firebase.json            # hosting セクション追加済み
├── .firebaserc              # default: lms-279
├── public-legal/            # Firebase Hosting 公開ディレクトリ
│   ├── index.html           # ランディング（/privacy, /terms へのリンク）
│   ├── privacy.html         # プライバシーポリシー（/privacy で公開）
│   └── terms.html           # 利用規約（/terms で公開）
└── docs/legal/              # マスター Markdown（編集時はこちらも同期）
    ├── privacy-policy.md
    └── terms-of-service.md
```

`cleanUrls: true` 設定により、`.html` 拡張子なしでアクセス可能:
- `https://lms-279.firebaseapp.com/` → `index.html`
- `https://lms-279.firebaseapp.com/privacy` → `privacy.html`
- `https://lms-279.firebaseapp.com/terms` → `terms.html`

## デプロイ手順

### 1. 事前確認

```bash
firebase --version
firebase projects:list  # lms-279 が表示されること
```

### 2. ローカルプレビュー（任意）

```bash
firebase emulators:start --only hosting
# => http://localhost:5000 で動作確認
```

ブラウザで以下を確認:
- http://localhost:5000/ : ランディングページ
- http://localhost:5000/privacy : プライバシーポリシー
- http://localhost:5000/terms : 利用規約

### 3. 本番デプロイ

```bash
firebase deploy --only hosting --project lms-279
```

正常時の出力:
```
✔  Deploy complete!
Project Console: https://console.firebase.google.com/project/lms-279/overview
Hosting URL: https://lms-279.firebaseapp.com
```

### 4. 動作確認

ブラウザで以下の URL にアクセスして 200 OK を確認:
- https://lms-279.firebaseapp.com/
- https://lms-279.firebaseapp.com/privacy
- https://lms-279.firebaseapp.com/terms

### 5. 既存 Firebase Auth への影響確認

Firebase Auth は `/__/auth/**` パスを使用するため、本 hosting 設定と干渉しない。

念のため既存ユーザー（例: `system@279279.net`）でログインして、認証が正常に動くことを確認:

1. https://web-3zcica5euq-an.a.run.app/ にアクセス
2. Google ログインを実行
3. 既存テナントにログインできることを確認

## Google Auth Platform 側の設定

### 承認済みドメイン

現状の `lms-279.firebaseapp.com` 1 件のままで OK（変更不要）。

### ブランディング URL 更新

https://console.cloud.google.com/auth/branding?project=lms-279 で以下を更新:

| 欄 | 新しい値 |
|---|---|
| アプリケーションのホームページ | `https://lms-279.firebaseapp.com/` |
| プライバシーポリシー リンク | `https://lms-279.firebaseapp.com/privacy` |
| 利用規約 リンク | `https://lms-279.firebaseapp.com/terms` |

旧 Google Docs URL は上書きする。

### 検証申請

1. 「保存」ボタンをクリック
2. 「ブランディングを確認」ボタン（右上）が active になるはず
3. クリックして検証申請を開始
4. 結果は `system@279279.net` に Google からメール通知（basic scopes のみのため自動承認される可能性が高い、通常数時間〜数日）

## 更新時のフロー

プライバシーポリシー / 利用規約の内容を変更する場合:

1. **マスターを更新**: `docs/legal/privacy-policy.md` または `docs/legal/terms-of-service.md` を編集
2. **HTML に反映**: `public-legal/privacy.html` または `public-legal/terms.html` を同期更新（手動変換、自動化は未実装）
3. **制定日・最終改定日を更新**: 両方のファイルの末尾日付
4. **デプロイ**: `firebase deploy --only hosting --project lms-279`
5. **PR**: コミット + PR で履歴管理

## ロールバック

```bash
firebase hosting:clone lms-279:live lms-279:live --release-id <previous-release-id>
```

または Firebase Console → Hosting → リリース履歴 から過去バージョンを戻す。

## 関連

- Issue #272: 外部ドメインユーザーログイン不可の恒久対応
- ADR-030 / ADR-031: 認証責務分離 / GCIP マルチテナント
- `docs/runbook/oauth-external-publish.md`: OAuth External 化手順
- `docs/runbook/tenant-and-allowlist-preflight-check.md`: テナント / allowed_emails 事前確認
- `docs/legal/privacy-policy.md` / `docs/legal/terms-of-service.md`: マスター Markdown
