# users.email 正規化運用手順 (Issue #285)

ADR-031 Phase 3（GCIP 移行）前に、`tenants/{tid}/users` コレクション内の大文字/前後空白混入メールを
正規化（`.trim().toLowerCase()`）するための運用手順です。これを怠ると:

- 現行 Firebase Auth 環境下でも、ログイン時に `getUserByEmail` が既存 user レコードに到達できず
  重複ユーザーが新規作成されて進捗データが orphan 化する
- GCIP 移行時は新 UID が発行され email fallback が必須になるため、未正規化 user が大量に orphan 化する

## 前提

- **PR #277 マージ済み**（allowed_emails の正規化 + セッション失効）
- **PR #280 マージ済み**（allowed_emails の棚卸しスクリプト）
- 本番 Firestore への認証情報（`GOOGLE_APPLICATION_CREDENTIALS`）取得済み
- **サービスのメンテナンスウィンドウ中に実行**（理由: 本スクリプトは read-then-write 方式で、実行中に API / 管理画面から同じユーザーの email が更新されると上書きされる可能性がある。トランザクション未使用）

> ⚠️ PR #284（Issue #278 継続的認可境界）は本 runbook の前提ではない。#284 は users.email の正規化を前提にする「消費側」の PR であり、本スクリプトは #284 の前に実行すべきか後に実行すべきかは運用判断（通常は並行/後でも問題ない）。

## 実行環境変数

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
export FIREBASE_PROJECT_ID=lms-279
```

## 手順

### Step 1: dry-run で差分可視化

```bash
cd <project-root>
npx tsx scripts/normalize-users-email.ts
```

出力される行:

| ラベル | 意味 | 想定アクション |
|--------|------|---------------|
| `[UPDATE] ...` | 正規化で書き換え予定（重複なし） | `--execute` で反映 |
| `[SKIP DUPLICATE] ...` | 正規化結果が既存 user.email と衝突 | **人手で人物同一性を判定**（次項参照） |

Summary:

- `updates: N` — 自動補正件数
- `skips: M` — 重複で手動対応が必要な件数

### Step 2: `[SKIP DUPLICATE]` レビュー（重複検出時の対応手順）

`skips > 0` の場合、スクリプトは自動では書き換えずに警告する。これは「email 正規化後に既存の正規化済み
ユーザーと衝突した」ケースで、以下のパターンが考えられる:

| パターン | 例 | 推奨アクション |
|---------|------|---------------|
| 同一人物の重複登録 | `Alice@x.com` と `alice@x.com` が別 userId で両方存在 | **手動マージ後に片方を削除**（下記 Step 2.1） |
| 似て非なる別人 | 偶然同じ email が別テナントで作成されたケース（通常発生しない） | 個別調査 |
| テストアカウント | 旧仕様で作成された不正データ | 削除 |

#### Step 2.1: 手動マージ手順（同一人物の重複登録と判明した場合）

1. 両 userId の `firebaseUid` / `createdAt` / `role` / `lastSignInTime` を Firebase Admin Console で確認し、
   **残す側**を決定する（通常はログイン実績のある方）
2. 進捗データ（`user_progress`, `course_progress`, `quiz_attempts`, `video_events`, `lesson_sessions`）の
   userId を残す側に手動マージ
   - **本 runbook 範囲外**: 進捗マージ用の共通スクリプトは現時点で未整備。件数が少ない場合は Firebase Console / Firestore CLI で手動 `set`、件数が多い場合は個別のマイグレーション PR で専用スクリプトを追加してから再実行する
3. 削除する側の `users/{id}` / `allowed_emails/{email}` を削除
4. Firebase Auth ユーザーも孤児になる場合は `scripts/cleanup-orphan-auth-users.ts` で掃除
   - **注: Phase 3 (GCIP) 移行後は GCIP Tenant 配下のユーザーは対象外**（ADR-031 既知の制約）。GCIP 移行後は別途 Tenant ごとの掃除手順を用意する必要がある
5. Issue #285 のコメント欄にマージ記録を残す（email、残した userId、削除した userId、判定根拠）

#### Step 2.2: 別人 / テストアカウントの場合

- 該当 users レコードのうち不要な方を削除
- 再度 Step 1 の dry-run で `[SKIP DUPLICATE]` が解消したことを確認

### Step 3: 一括補正（`[UPDATE]` のみの場合）

skips が 0 件、または Step 2 で解消済みなら `--execute` で一括書き換え:

```bash
npx tsx scripts/normalize-users-email.ts --execute
```

出力の `updates: N` が期待件数と一致することを確認する。

### Step 4: 再実行で差分ゼロを確認

```bash
npx tsx scripts/normalize-users-email.ts
```

`updates: 0, skips: 0` なら正規化完了。ADR-031 Phase 3（Issue #272）に進める。

## トラブルシュート

### `[SKIP DUPLICATE]` が想定外に大量に出る

- Firestore で過去に人物同一の重複登録が放置されていた可能性
- 個別対応が現実的でない場合は、Issue #285 のコメントで方針相談（例: 片側を一律削除するか、人手レビューを続けるか）

### スクリプトが途中で失敗する

- `GOOGLE_APPLICATION_CREDENTIALS` のサービスアカウントに Firestore 書き込み権限があるか確認
- ネットワーク断であれば再実行（冪等: 既に正規化済みの doc は `raw === normalized` で skip される）

### 同一 email を持つ複数 users の扱い

本スクリプトは「**正規化前後で衝突する**」ケース（=少なくとも 1 件が未正規化）のみ `[SKIP DUPLICATE]` として検出する。「既に両方正規化済みだが同一 email」という重複は本スクリプトでは検出されない。

既存の `scripts/audit-users-vs-allowed-emails.ts` は主目的が users↔allowed_emails の対応関係監査で、同一 email を持つ複数 users については `[DUPLICATE USERS]` 警告を副次的に出すのみ（runbook `docs/runbook/allowed-emails-audit.md` 末尾参照）。両方正規化済みの email 重複を網羅的に検出するには、別途監査スクリプトの追加を検討すること。

## 参考

- Issue #285: 本スクリプトのスコープと Acceptance Criteria
- Issue #272 / ADR-031: GCIP 移行（Phase 3）で email fallback が必須になる根拠
- PR #277: allowed_emails 側の先行正規化（`scripts/normalize-allowed-emails.ts`）
- PR #284 Codex セカンドオピニオン: users.email 未正規化問題の指摘元
