# allowed_emails 棚卸し運用手順 (Issue #279)

Issue #278（既存 users 経路にも allowlist 再チェックを追加する案B）を本番デプロイする前に、
「users レコードは存在するが allowed_emails に登録されていない」ユーザーを検出・補正するための
手順です。これを怠ると本番デプロイ直後に許可すべき既存ユーザーが一斉に弾かれます。

## 前提

- **PR #277（allowed_emails 削除時のセッション即時失効 + email 正規化）マージ済み**
- PR #277 に含まれる `scripts/normalize-allowed-emails.ts --execute` 実行済み（既存大文字混入データの正規化）
  - **本スクリプトは PR #277 マージ後にしか存在しない**。PR #277 マージ前に本手順を実行すると、大文字混在データが `matched` 判定を外れて誤って⚠️補正候補に入る
  - マージ状況の確認: `git ls-tree origin/main scripts/ | grep normalize-allowed-emails`
- 本番 Firestore への認証情報（`GOOGLE_APPLICATION_CREDENTIALS`）取得済み
- `SUPER_ADMIN_EMAILS` 環境変数が本番と同じ値で設定されている（未設定だと本来除外すべきユーザーが⚠️補正候補に混入する）

## 実行環境変数

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
export FIREBASE_PROJECT_ID=lms-279
export SUPER_ADMIN_EMAILS="admin1@example.com,admin2@example.com"
```

## 手順

### Step 1: dry-run で差分を可視化

```bash
cd <project-root>
npx tsx scripts/audit-users-vs-allowed-emails.ts
```

出力される分類:

| ラベル | 意味 | 想定アクション |
|--------|------|---------------|
| ✅ matched | users と allowed_emails の両方にある | なし（正常） |
| ⚠️ usersWithoutAllowedEmail | users にあるが allowed_emails にない | **人手レビュー後に補正** |
| 🟡 allowedEmailsWithoutUser | allowed_emails にあるが users にない | なし（招待済み未ログイン） |
| ❌ invalid | email が空/null の不正データ | 個別調査・修復 |
| 🟢 excludedSuperAdmins | スーパー管理者は補正対象外 | 判定参考出力のみ |

### Step 2: ⚠️ リストを人手でレビュー

⚠️ グループの各エントリに以下の情報が表示されます:

- `email`: 正規化済みメール
- `role`: users レコードの role（admin / teacher / student）
- `userId`: Firestore ドキュメント ID
- `firebaseUid`: Firebase Auth UID（未ログイン時は `(none)`）
- `createdAt`: users レコード作成日時
- `lastSignInTime`: Firebase Auth の最終サインイン（取得不可なら `unknown`）

**補正対象から除外すべきケース**:

- 退職者・受講終了者（`lastSignInTime` が古く、業務上ログイン不要）
- テスト用アカウント
- 誤って作成された users レコード

この判断はスクリプトでは自動化せず、必ず管理者の目視レビューを経ること。

**除外判定の記録（事後監査のため必須）**:

除外した email と判定理由は、**Issue #279 のコメント欄に追記**してから Step 3 に進むこと。
記録フォーマット:

```
## dry-run 実施 YYYY-MM-DD HH:MM by <担当者>
- tenant=<tid1>: ⚠️ N 件中、除外 M 件
  - excluded: alice@x.com (退職 2025-12)
  - excluded: bob@x.com (テストアカウント)
  - to-add: carol@x.com, dave@x.com
```

これにより Issue #278 デプロイ後に「なぜこのユーザーが allowed_emails にいない/いるのか」を追跡可能にする。

### Step 3: 補正方針の決定

| ケース | 推奨アクション |
|--------|---------------|
| ⚠️ 全員を補正対象にしてよい | `--fix --execute` で一括追加 |
| 一部のみ補正 | 管理画面から個別に allowed_emails に追加 |
| 全員が退職者等で補正不要 | 何もしない（Issue #278 デプロイで削除される） |

### Step 4: 一括補正（必要な場合のみ）

まず dry-run で追加候補を確認:

```bash
npx tsx scripts/audit-users-vs-allowed-emails.ts --fix
```

出力される行:

- `[FIX] ...`: 追加候補（未登録エントリ）
- `[SKIP EXISTING] ...`: 既に allowed_emails に存在するためスキップ（通常 0 件、他オペレータの競合時のみ発生）

Summary の `allowed_emails would add: N` が期待件数と一致することを確認してから実行:

```bash
npx tsx scripts/audit-users-vs-allowed-emails.ts --fix --execute
```

追加された allowed_emails レコードには自動で以下の note が付きます:

```
audit-fix (Issue #279) by scripts/audit-users-vs-allowed-emails on YYYY-MM-DD
```

### Step 5: 個別補正（管理画面経由）

管理画面から対象メールを allowed_emails に追加する。
`note` は手動で記載し、トレーサビリティのため Issue 番号を含めることを推奨:

```
手動追加 Issue #279 on YYYY-MM-DD by <担当者>
```

### Step 6: 再実行で差分ゼロを確認

```bash
npx tsx scripts/audit-users-vs-allowed-emails.ts
```

`totalUsersWithoutAllowedEmail: 0` なら棚卸し完了。Issue #278 の実装・マージに進めます。

## オプション

| オプション | 用途 |
|-----------|------|
| `--tenant <id>` | 特定テナントのみ処理（デバッグ時） |
| `--super-admins <csv>` | env と Firestore の union に手動で追加 |
| `--skip-auth-metadata` | Firebase Auth の `lastSignInTime` 取得をスキップ（高速化） |

## トラブルシュート

### スーパー管理者が 0 件と警告される

`SUPER_ADMIN_EMAILS` 環境変数が本番と異なる or Firestore `superAdmins` コレクションが空。
`services/api/src/middleware/super-admin.ts` と同じ情報源で判定しているため、本番設定と一致させる。

### 一部ユーザーの lastSignInTime が unknown

- users レコードの `firebaseUid` が空（ログイン履歴なし）
- Firebase Auth ユーザーが削除済み（users レコードは残存）
- getUsers バッチ取得が失敗（コンソールに warning）

いずれも判定材料不足を意味するので、他の情報（createdAt、role）と組み合わせて判断する。

### スクリプト実行が遅い

`--skip-auth-metadata` で Firebase Auth 取得をスキップすると高速化できる。
ただし `lastSignInTime` が常に `unknown` になるため、レビュー判断材料が減る点に注意。

### `⚠️ [DUPLICATE USERS]` 警告が出た

同一 email を持つ users レコードが 2 件以上存在している。`planAudit` は最初の 1 件のみ採用して後続を無視するため、補正対象件数と実 users 件数がズレる可能性がある。本スクリプトの範囲外（別途個別対応: 重複 user レコードのクリーンアップ）だが、⚠️グループに入ったエントリの userId と、警告に表示された userIds 群を突き合わせて整合性を確認すること。

### `⚠️ Firestore superAdmins コレクションの取得に失敗` 警告が出た

Firestore 権限エラーや一時的なネットワーク障害。**dry-run では続行するが、レポート上のスーパー管理者リストが不完全になり、本来除外すべきユーザーが⚠️補正候補に混入する**。`--execute` 時は fatal で中断される。原因を解消してから再実行すること。

### `⚠️ Firebase Auth getUsers バッチ取得に失敗` 警告が出た

Firebase Auth のレート制限やネットワーク障害でユーザー情報が取れなかった。対象ユーザーは `lastSignInTime=unknown` として表示されるため、**「退職候補」と誤判定しないよう注意**。`--execute` 時は fatal で中断される。

## 参考

- Issue #279: 本棚卸しのスコープと Acceptance Criteria
- Issue #278: 案B（既存 users 経路にも allowlist 再チェック）の実装
- PR #277: 前提となる削除時即時失効 + email 正規化
- `services/api/src/services/allowed-email-audit.ts`: 純粋ロジック + 型定義
- `services/api/src/middleware/super-admin.ts`: 本番スーパー管理者判定
