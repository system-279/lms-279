# ADR-034: Phase 2 受講者進捗 PDF Gmail 下書き作成

- Status: **Accepted** (PR #358 で実装済、2026-05-19 Issue #433 で宛先ロジックを案 B に改訂)
- Date: 2026-05-14 (初版) / 2026-05-19 (案 B 改訂)
- Deciders: system-279, sanwaminamihonda@gmail.com
- 関連: ADR-032 (Phase 1 採択), ADR-033 (Rejected — SMTP relay 案), Issue #346 (Phase 2 起票), Issue #433 (宛先ロジック改訂)

## 改訂履歴

- **2026-05-21 (Issue #435)**: idempotency アトミック化 + 状態遷移ログ。Codex review High 1 / 3 を反映 (High 90: `recordPdfDraftLog().set()` 混在 / Medium 86: orphan pending 復旧 / Low 82: failed mock test は本 PR scope 外、follow-up Issue 化)。
  - §7 監査ログスキーマ: `status` を `"pending" | "success" | "failed"` に拡張。`finalizedAt` (状態遷移時刻) を追加。
  - §3 idempotency 構造を全面再設計 (transaction ベース):
    1. 旧手動 `docRef.get()` による early-return は **撤去** (acquire transaction に統合、二重判定の race を排除)
    2. Gmail draft 作成の直前に `acquirePendingPdfDraftLog` を呼ぶ。内部実装は **Firestore `runTransaction`** で `tx.get(docRef)` → 状態判定 → `tx.create` / `tx.set` を 1 アトミック単位で実行
    3. 状態遷移仕様:
       - `不存在` → `tx.create(pending)` → `kind: "acquired"`
       - `existing pending` → 並行 2 件目 → `kind: "in_flight"` (route で 409 `invalid_request_id`)
       - `existing success + createdByUid/userId 一致` (旧スキーマ欠落は許容) → `kind: "existing_success"` (route で 200 既存 draftId)
       - `existing success + 不一致` → `kind: "collision"` (route で 409 `invalid_request_id`、別 actor の draft 横取り防止)
       - `existing failed` → `tx.set(pending)` で **上書き再試行** → `kind: "acquired"` (旧 `docRef.create()` では実装不可だった failed リトライを transaction で解決)
    4. Gmail draft 成功 → `finalizePdfDraftLog` で `pending → success` に merge update
    5. Gmail draft 失敗 → `finalizePdfDraftLog` で `pending → failed` に merge update
  - §8 エラー分類: acquire transaction の throw (Firestore 障害) は **503 `gmail_api_transient`** で停止 (旧フォールスルー廃止、AC-3 対応)。
  - 並行 2 リクエストで Gmail draft が 1 件のみ作成される (AC-1、transaction で原子性保証)、`requestId` 再利用 + 別 userId は 409 (AC-2、acquire transaction で認可境界判定)、旧スキーマ互換維持 (AC-4)、pending → success/failed 状態遷移ログ (AC-5)。
- **2026-05-21 (Issue #436)**: access token owner 検証を追加。Codex review (Medium 2 件) 反映済み。
  - §3 OAuth フロー: BE は Gmail API 呼び出し前に `oauth2.tokeninfo` で access token の発行元 Google アカウント email を取得し、Firebase Auth (`superAdmin.email`) と一致するか検証する。不一致なら **403 `access_token_owner_mismatch`** + Gmail API 呼ばない。`verified_email !== true` (Google が email 所有を確認していない) も **401 `invalid_access_token`** で拒否する (Codex Medium 68 対応)。
  - §3 idempotency 認可境界: 既存 success ログを 200 で返す際に、`createdByUid` + `userId` が現在 actor と一致する場合のみ返す。不一致なら **409 `invalid_request_id`** (別 super admin / 別 受講者 の既存 draft 横取り防止、Codex Medium 82 対応)。旧スキーマ (`createdByUid` 不在) は後方互換で従来通り許容。
  - §7 監査ログスキーマ: `tokenOwnerHash` (sha256(token owner email)) を追加。一致/不一致/取得不能のいずれでも記録 (取得不能時は null)。
  - §8 エラー分類: `access_token_owner_mismatch` (403) / `invalid_access_token` (401、unverified email) / `invalid_request_id` (409、idempotency 認可境界) を追加 (`invalid_request_id` は既存コードで HTTP 状態のみ追加)。
  - 目的: API 直叩き (curl/Postman) で別 Google アカウントの access token (gmail.compose scope) を渡されたとき、その mailbox に PDF 下書きが作成されるのを防ぐ + idempotency 経路でも認可境界を保つ + 監査ログで token owner 不一致を検出可能にする。
- **2026-05-19 (Issue #433)**: 宛先ロジックを **案 B (To = 受講者本人 / CC = テナント管理者)** に改訂。
  - 旧 §5: To = ownerEmail のみ (UI 単位 = 受講者なのに宛先が管理者で不整合)
  - 新 §5: To = `users/{userId}.email` (受講者本人) / CC = `tenants/{tenantId}.ownerEmail` (省略可)
  - 旧エラー `owner_email_not_set` は deprecated (案 B では CC 省略で送信成功)
  - 新エラー `user_email_not_configured` / `invalid_owner_email` を追加
  - 監査ログ dual-write: 既存 `ownerEmailHash` を残置しつつ `recipientToHash` / `recipientCcHash` を追加
  - 本文テンプレートを「{userName} 様」呼びかけに変更、CC 注記は ownerEmail 設定時のみ追加

## Context

ADR-032 Phase 2 (Issue #346) の「スーパー管理者からテナント管理者へ受講者進捗 PDF を自動送信する」要件について、impl-plan 段階でユーザー希望の再確認を行った結果、当初想定 (ADR-033: バックエンド SMTP relay + 専用アドレス `lms-noreply@279279.net` + 自動送信) とは異なる以下のイメージであることが判明した。

> 「そのスーパー管理者がログインしているアカウントで Gmail のメーラー画面が立ち上がるようなイメージ」
> 「送信元はその時のスーパー管理者のアカウント」
> (2026-05-14 ユーザー回答より)

このため ADR-033 を Rejected 化し、本 ADR で「Gmail API `users.drafts.create` 経由でスーパー管理者本人の Gmail 下書きフォルダに PDF 添付付きメールを作成し、Gmail Web UI で確認・編集・送信する」方式を採用する。

## Decision

### 1. 採用方式: Gmail API `users.drafts.create` + Frontend OAuth popup

Phase 2 の Acceptance Criteria に挙げた「自動送信」を、**「Gmail 下書き自動作成 + Gmail UI へ自動遷移」** に再定義する。

### 2. アーキテクチャ

```
[FE]                                         [BE]                            [Google]
 ├─ 「下書き作成」ボタン押下
 ├─ GoogleAuthProvider.addScope("gmail.compose")
 ├─ signInWithPopup or reauthenticateWithPopup
 │   └─→ Google OAuth 同意画面 (初回のみ) ──→ access_token 取得
 ├─ POST /api/v2/super/.../progress-pdf-draft
 │   body: { requestId, sections, accessToken }
 │                                            ├─ 越境チェック (Phase 1 と同じ)
 │                                            ├─ tenant.ownerEmail / user.email 取得・バリデーション
 │                                            ├─ PDF 生成 (Phase 1 ロジック再利用)
 │                                            ├─ MIME multipart 組み立て (案 B)
 │                                            │   (Subject / From: 'me' / To: user.email
 │                                            │    / Cc: ownerEmail (設定済時のみ) / Body / PDF 添付)
 │                                            ├─ Gmail API: users.drafts.create
 │                                            │   ├─ Authorization: Bearer {accessToken}
 │                                            │   └─→ Google ─→ { id: draftId, message: {...} }
 │                                            ├─ 監査ログ書き込み (pdf_draft_logs)
 │                                            └─ 201 { draftId, draftUrl }
 ├─ window.open(draftUrl, "_blank")
 │   └─→ Gmail Web UI で下書き表示 ────────────────────────→ スーパー管理者が確認・編集・送信
```

### 3. OAuth フロー: Frontend popup + per-request access token

- Firebase Auth `GoogleAuthProvider` に `https://www.googleapis.com/auth/gmail.compose` scope を追加
- 「下書き作成」ボタン押下時に `signInWithPopup` (初回) または `reauthenticateWithPopup` (2 回目以降) で access token を取得
- access token は **FE → BE への 1 リクエストでのみ使用、BE で保持しない**
- refresh token は要求しない (`access_type=online`)

#### 採用理由
- Secret Manager / Firestore 暗号化保存が不要 (BE は token を保持しない)
- 既存の Firebase Auth + Google ログインフロー上の単純な scope 追加で実現
- スーパー管理者の操作頻度想定 (月数十回) なら毎回 popup でも UX 許容範囲

#### access token owner 検証 (Issue #436、2026-05-21 追加)

通常経路では FE が `reauthenticateWithPopup(currentUser, provider)` を使うため、access token は currentUser の Google アカウントから発行され、`superAdmin.email` (Firebase Auth) と一致する想定。ただし API 直叩き (curl/Postman) で別 Google アカウントの access token を渡された場合、Gmail API は token 所有者の mailbox に下書きを作成してしまう。これを防ぐため BE は以下を実施する:

1. `parseBody` で `accessToken` を取得後、`idempotency check` の直後 / `tenant doc` 取得の前で **`oauth2.tokeninfo({ access_token })`** を呼び出して owner email を取得
2. owner email を `trim().toLowerCase()` で正規化し、`superAdmin.email.trim().toLowerCase()` と比較
3. **一致** → 続行 (取得した owner email は `tokenOwnerEmail` として監査ログに記録)
4. **不一致** → Gmail API 呼ばずに **403 `access_token_owner_mismatch`** + 失敗監査ログ
5. **`tokeninfo` 失敗** → エラー分類に従う (401 invalid_access_token / 503 gmail_api_transient / 502 gmail_api_error) + 失敗監査ログ

実装: `services/api/src/services/gmail-draft.ts` の `verifyAccessTokenOwner(accessToken)` (`classifyGmailError` 経由でエラー分類を Gmail API と共有)。

### 4. メール文面テンプレート

```
件名: 【{tenantName}】{userName} さんの受講進捗レポート ({YYYY-MM-DD})

本文:
お世話になっております。

{tenantName} の {userName} さんの受講進捗レポートを作成しました。
PDF を添付しておりますのでご確認ください。

【現在の状況】
- 進捗率: {progressPercent}% ({completedLessons}/{totalLessons} レッスン完了)
- 受講期限: {deadlineSummary}
- 推奨ペース: {paceSummary}

ご質問やご相談がありましたら、本メールにご返信ください。

{senderName}
```

可変項目:
- `tenantName` — テナント表示名
- `userName` — 受講者氏名 (未設定なら email)
- `YYYY-MM-DD` — 生成日 (JST)
- `progressPercent` — 進捗率 (0-100)
- `completedLessons` / `totalLessons` — 完了レッスン数 / 全レッスン数
- `deadlineSummary` — 期限サマリー (Phase 1 の `deadlineDisplay` を再利用)
- `paceSummary` — 推奨ペース (Phase 1 の `paceDisplay` を再利用)
- `senderName` — スーパー管理者の Firebase Auth displayName (なければ email)

スーパー管理者は Gmail UI で件名・本文・宛先・CC/BCC を自由に編集可能。

### 5. 宛先決定 (案 B、2026-05-19 改訂、Issue #433)

UI フローは特定受講者単体 (userId 指定) で動作するため、宛先も受講者本人を主にする
**案 B (To = 受講者本人 / CC = テナント管理者)** を採用する。

- **To**: `users/{userId}.email` (trim 後)。空白/CRLF/カンマ/制御文字/形式違反は **BE 400 `user_email_not_configured`**。
- **Cc**: `tenants/{tenantId}.ownerEmail` (trim 後)。null/空文字は CC ヘッダ自体を発行せず送信成功 (後方互換)。
  CRLF/カンマ/制御文字/形式違反は **BE 400 `invalid_owner_email`** (ヘッダインジェクション防御)。
- **Bcc**: 未対応 (スーパー管理者が Gmail UI で手動追加)。
- **From**: Gmail API では `'me'` 指定 (= access token 所有者 = ログイン中のスーパー管理者)。

#### 採用理由

| 観点 | 旧 (To=ownerEmail) | 案 B (To=user / CC=owner) |
|---|---|---|
| UI フロー (受講者単体) との整合 | ❌ ズレ | ✅ 整合 |
| 個人ごとの送付先 | ❌ テナント単位で固定 | ✅ 受講者ごとに自動切替 |
| 誤送信防止 | ❌ 手動入力リスクあり | ✅ 自動入力 |
| 管理者への共有 | ✅ 直接送信 | ✅ CC で共有 |
| 透明性 (本人が共有先を認識) | — | ✅ CC で開示 |
| 後方互換 (ownerEmail 未設定テナント) | ❌ 送信不可 | ✅ CC 省略で送信成功 |

#### バリデーションルール

```typescript
function validateRecipientEmail(input: unknown):
  | { ok: true; value: string }
  | { ok: false; reason: "empty" | "crlf" | "comma" | "control" | "format" };
```

- `empty`: trim 後 0 文字 (To=400 / CC=null として CC 省略)
- `crlf`: CR/LF 含む → ヘッダインジェクション → 400
- `comma`: カンマ含む → 複数宛先化リスク (案 B は本人単体前提) → 400
- `control`: 制御文字 `\x00-\x1f\x7f` 含む → 400
- `format`: `/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/` 違反 → 400

### 6. PDF 添付

- Phase 1 の `buildProgressPdfData` + `ProgressPdfDocument` + `renderToBuffer` を**そのまま再利用**
- PDF Buffer を base64 エンコード → MIME multipart `attachment` パートに埋め込み
- GCS への一時保存は**不要** (ADR-033 の TTL 7 日方式は不採用)
- ファイル名: `progress-{受講者名sanitized}-{YYYY-MM-DD}.pdf` (Phase 1 と同じ命名)
- PDF サイズ上限: **Gmail 添付上限 25MB に対し 5MB 上限を維持** (Phase 1 と整合、超過時 413)

### 7. 監査ログスキーマ (案 B 改訂、dual-write)

```typescript
// tenants/{tenantId}/pdf_draft_logs/{requestId}
{
  createdAt: string;            // ISO 8601 (JST)
  createdByUid: string;         // Firebase UID
  createdByEmailHash: string;   // sha256(email)
  userId: string;               // 対象受講者 ID

  // 案 B (Issue #433) 新規追加
  recipientToHash: string | null;  // sha256(user.email) = 受講者本人 (To)
  recipientCcHash: string | null;  // sha256(ownerEmail) = 管理者 (CC、未設定なら null)

  // 後方互換 (deprecated、旧 To 宛先 = ownerEmail のハッシュ。案 B 移行後は recipientCcHash と同値)
  ownerEmailHash: string | null;

  // Issue #436 新規追加 (2026-05-21): access token の発行元 Google アカウント email
  // - 成功時: token owner = createdByEmail (一致) のハッシュを記録
  // - 不一致時: token owner (attacker 等) のハッシュを記録 → createdByEmailHash と異なる
  // - tokeninfo 失敗時: null (取得不能)
  tokenOwnerHash: string | null;

  draftId: string | null;       // Gmail draft ID (成功時)
  // Issue #435: pending → success/failed の状態遷移を表現
  status: "pending" | "success" | "failed";
  errorCode: string | null;
  sections: ProgressPdfSections;
  pdfSizeBytes: number | null;
  ttlAt: Timestamp;             // 90 日後 (Firestore TTL ポリシー)
  // Issue #435: pending → success/failed 遷移時刻 (運用追跡用)
  finalizedAt?: string;         // ISO 8601 (finalize 呼び出し時に追記)
}
```

#### dual-write 戦略

- 既存 `ownerEmailHash` は読み手 (運用 query / 旧分析) が両方を読める間は維持
- 新 `recipientToHash` / `recipientCcHash` を追加で書き込み
- idempotency 判定は `status === "success" && typeof draftId === "string"` のみで行い、
  新フィールドの有無に依存しない (旧スキーマ success ログでも 200 を返す、AC-13)

#### PII 最小化と保管

- 受信者メールはハッシュのみ、PDF 内容は保存しない
- TTL 90 日で自動削除 (Phase 1 の `pdf_send_logs` 想定と整合)

### 8. エラー分類

| HTTP | error code | 状況 | FE 動線 |
|---|---|---|---|
| 400 | `bad_request` / `invalid_sections` / `invalid_request_id` | 入力エラー | エラーメッセージ表示 |
| 400 | `demo_tenant_not_supported` | demo テナント | エラーメッセージ表示 (Phase 1 と整合) |
| 400 | `no_sections_selected` | 全 section が false | エラーメッセージ表示 (Phase 2 で新規) |
| 400 | `user_email_not_configured` | 受講者 email 未設定/空白/不正 (案 B 新規) | ボタン disabled (二重防御) |
| 400 | `invalid_owner_email` | ownerEmail に CRLF/カンマ/制御文字/形式違反 (案 B 新規) | エラーメッセージ表示 |
| 400 | `owner_email_not_set` (deprecated) | 旧仕様で ownerEmail 未設定時に返していた。案 B 移行後は通常経路で返らない | (後方互換用、型からは外さない) |
| 401 | `unauthorized` | Firebase ID token 期限切れ | 再ログイン誘導 |
| 401 | `invalid_access_token` | access token 期限切れ / `tokeninfo` で 401 / `verified_email !== true` (Issue #436) | reauthenticateWithPopup で再取得 |
| 403 | `gmail_scope_required` | access token に gmail.compose scope なし | reauthenticateWithPopup で再同意 |
| 403 | `access_token_owner_mismatch` | access token の owner email が `superAdmin.email` と不一致 (Issue #436) | エラーメッセージ表示 (API 直叩きでないと通常経路で出ない) |
| 409 | `invalid_request_id` | idempotency collision: 既存 success ログの `createdByUid`/`userId` が現在 actor と不一致 (Issue #436) / 既存 `pending` ログあり (Issue #435 並行リクエスト) | エラーメッセージ表示 (API 直叩きでないと通常経路で出ない) |
| 404 | `tenant_not_found` / `user_not_in_tenant` | 越境/不存在 | エラーメッセージ表示 (Phase 1 と整合) |
| 413 | `pdf_too_large_for_gmail` | PDF > 5MB | エラーメッセージ表示 |
| 429 | `gmail_quota_exceeded` | Gmail API quota 超過 | 「しばらく待ってから再試行」メッセージ |
| 500 | `pdf_generation_failed` | PDF 生成失敗 (Phase 1 と整合) | エラーメッセージ表示 |
| 502 | `gmail_api_error` | Gmail API 5xx | エラーメッセージ表示 + 再試行誘導 |
| 503 | `gmail_api_transient` | ネットワーク/transient | 再試行誘導 |

### 9. 下書き作成成功時の UX

- BE レスポンス: `{ draftId: string, draftUrl: string }`
- `draftUrl` = `https://mail.google.com/mail/u/0/?ogbl#drafts/{draftId}`
- FE は `window.open(draftUrl, "_blank", "noopener,noreferrer")` で新規タブで開く
- スーパー管理者は Gmail Web UI で本文・宛先確認 → 編集 → 送信

### 10. Phase 1 機能との関係

- Phase 1 の「PDF 生成」ボタンは**そのまま残す** (Gmail を使わず PDF だけダウンロードしたい場面の fallback)
- 新規「Gmail 下書き作成」ボタンを隣に追加
- 同じセクション選択 UI を共有

## Alternatives Considered

### A. ADR-033 SMTP relay 自動送信 (Rejected)

不採用理由: ユーザー希望と相違 (送信元固定、新規アドレス発行、DNS 整備が不要 + 不適切)。詳細は [ADR-033 Rejected 理由](./ADR-033-phase2-smtp-selection.md#rejected-理由-2026-05-14) 参照。

### B. Gmail Compose URL (`mailto:` 拡張)

```
https://mail.google.com/mail/?view=cm&to=...&su=...&body=...
```

不採用理由:
- **PDF 添付不可** (Compose URL では添付ファイル指定不可)
- ユーザーが PDF を手動ダウンロード → Gmail 画面で手動添付の二度手間
- 採用すれば実装最小だが、Phase 2 の主目的「PDF を管理者に届ける」を AI 側で完結できない

### C. Google Drive 経由 (Compose URL + Drive リンク本文挿入)

不採用理由:
- PDF を Drive に永続化 → 削除運用負荷
- Drive 共有権限管理が別途必要
- 受信者が Drive を開いてダウンロード → メールに添付されている方が業務フロー自然

### D. Backend OAuth code フロー + refresh token 保持

- スーパー管理者が初回のみ OAuth code フローで承認 → refresh token を Secret Manager 等に暗号化保存
- 以降は BE で refresh token から access token を都度発行

不採用理由:
- Secret Manager / Firestore 暗号化保存 + 別 OAuth client 設定が必要 (実装大幅増)
- token 漏洩リスク (per-request popup より高い)
- スーパー管理者の頻度想定 (月数十回) では popup 毎回でも UX 許容範囲
- DWD (ADR-026) と混同しないため、本人 Gmail 用 OAuth client は別途必要

### E. クライアントサイド Gmail API 直接呼び出し (BE 経由なし)

不採用理由:
- PDF 生成ロジックを FE に重複実装する必要 (`@react-pdf/renderer` を Web bundle に含めると Phase 1 のサーバーサイド方針 (ADR-032) と乖離)
- 監査ログ書き込みを FE から行うと改ざんリスク
- BE で集約することで Phase 1 の進捗データ集約ロジックを再利用可

## Consequences

### 良い影響

- **追加コスト 0 円** (Workspace ライセンス・新規アドレス不要)
- **DNS 整備不要** (SPF/DKIM/DMARC は Workspace 既存設定で十分)
- **Secret Manager / IAM 設計不要** (BE で token 保持しない)
- スーパー管理者本人のアドレスから送信されるため受信者にとって誰からのメールか明確
- Gmail UI で送信前に内容確認・編集可能 → 誤送信リスクが SMTP 自動送信より低い
- Phase 1 の PDF 生成ロジックを完全再利用 (二重実装ゼロ)

### 注意点・残存リスク

- **スーパー管理者の OAuth 追加同意が必要**: 初回ボタン押下時に popup で `gmail.compose` scope の同意を求める。既存ログインセッションへの影響はないが、利用説明が必要 (`docs/runbook/` で運用手順整備予定)
- **access token を BE に送る経路**: HTTPS で透過送信。BE は受信した token をログに記録せず、Gmail API 呼び出し直後にメモリから破棄。**ログ記録時は token を masking する実装が必須**
- **Gmail API quota**: per-user 250 quota unit/sec、`drafts.create` ≈ 35 unit。月数十通の運用 volume では問題なし。一括処理 (将来 Phase 3) でのみ要注意
- **下書き作成後の送信は scope 外**: ユーザーが Gmail 画面を開いて手動送信。本 ADR では送信完了の確認・追跡はしない (Gmail 送信履歴は Workspace 管理コンソールで確認可)
- **Gmail Web UI の URL 形式変更リスク**: `https://mail.google.com/mail/u/0/?ogbl#drafts/{draftId}` は Google 側仕様変更で壊れる可能性。壊れた場合は `https://mail.google.com/mail/u/0/#drafts` で下書きフォルダを開く fallback を実装可能

### Phase 2 実装着手のブロッカー

**なし** (本 ADR Proposed 段階で実装着手可能。Accepted 化は実装完了 + テスト PASS + ユーザー判断後)

## 実装メモ (2026-05-14, 評価で発覚した暫定対応)

### `senderName` の暫定対応

ADR §4 では「Firebase Auth `displayName` (なければ email)」とテンプレ化したが、
初版実装 (`services/api/src/routes/super/progress-pdf-draft.ts:248`) では
`createdByEmail` 固定としている。理由:

- dev モードの `req.superAdmin` には `firebaseUid` のみで `displayName` を保持していない
- firebase モードでは Firebase Auth Admin SDK 経由で `getUser(uid).displayName` を取れるが、
  PDF 生成パスで Firestore + Gmail API + Firebase Auth の往復が増える

今後 displayName を採用する場合は `superAdmin` に `displayName` を含める middleware 拡張、
または現状の `createdByEmail` 固定を Accept する。スーパー管理者は Gmail UI で本文編集可能なため、
業務上のインパクトは低い。

### `reauthenticateWithPopup` の挙動

ADR §3 で「2 回目以降はサイレント」と書いたが、Firebase の `reauthenticateWithPopup` は
**毎回認証 popup を表示する仕様** (Google 側の OAuth 同意キャッシュとは独立)。
ブラウザでアカウント選択 popup が毎回出るため、ADR の「UX 自然」は楽観的だった。

軽減策:
- 「下書き作成」ボタンを連打しないよう、push 後 `draftCreating=true` で disabled
- 同一 `requestId` の重複リクエストは BE 側 idempotency で既存 draftId/URL を返却 (200)

将来的に refresh token + offline access を採用すれば popup 完全排除可能だが、
Secret Manager 設計と運用負荷が増えるため Phase 2 では見送り。

## AC 充足状況 (Evaluator 分離プロトコル)

実装後、別 context の evaluator agent で AC 12 件を検証。指摘 (HIGH 1, MEDIUM 3, LOW 多数) を反映した。

| AC | 状況 |
|---|---|
| AC-1 (gmail.compose 同意) | UNTESTABLE-but-OK (実機 popup 依存。`requestGmailComposeAccessToken` が `GMAIL_COMPOSE_SCOPE` を addScope する単体テストは将来追加候補) |
| AC-2 (成功 201) | PASS — `progress-pdf-draft.test.ts` 統合テスト |
| AC-3 (ownerEmail 未設定 disable) | PASS — `page.test.tsx` component test 追加 |
| AC-4 (quota 429) | PASS — 統合テスト + gmail-draft 単体 |
| AC-5 (scope 403 + FE 再同意) | PASS — 統合テスト + `page.test.tsx` で再同意リトライを検証 |
| AC-6 (demo 400) | PASS |
| AC-7 (越境 404) | PASS |
| AC-8 (PII 最小化監査ログ) | PASS — `pdf-draft-audit.test.ts` で raw email 残留なしを検証 |
| AC-9 (window.open Gmail) | PASS — `page.test.tsx` で stubGlobal("open") を検証 |
| AC-10 (no_sections_selected) | PASS |
| AC-11 (PDF > 5MB 413) | PASS — 5MB ちょうど通過 + 5MB+1B 拒否の境界値テスト |
| AC-12 (失敗時監査ログ + エラー) | PASS — 統合テストで status=failed と errorCode 検証 |

### Evaluator 指摘対応の主要修正

- **HIGH-1**: access token がエラーログに漏洩するリスク → `originalError` を logger に渡さず `errorMessage` 文字列のみ記録するよう修正 (`progress-pdf-draft.ts:345-353`)
- **MEDIUM-2**: idempotency 重複ガード未実装 → ハンドラ先頭で `pdf_draft_logs/{requestId}` を確認し、`status=success` の既存ログがあれば 200 で既存 `draftId`/`draftUrl` を返却 (`progress-pdf-draft.ts:166-198`)
- **MEDIUM-3**: `getFirestore()` の 2 回呼び出し → ハンドラ先頭で 1 回取得して使い回し
- **MEDIUM-4**: CRLF 改行混在 → `progress-pdf-mail-template.ts` の body を `\r\n` join に統一
- **MEDIUM-5**: `requestId` の `/` 含む文字列を Firestore パスインジェクション防止のため拒否 (`REQUEST_ID_REGEX`)
- **MEDIUM-6**: `ownerEmail` ヘッダインジェクション防止 → CR/LF を含む値を `owner_email_not_set` で拒否

LOW 指摘 (sanitizeFilename 日本語 _ 化、popup ブロック検出のブラウザ依存、ADR `Status: Proposed` のまま等) は別 PR / 別 Issue で検討。

## 関連

- ADR-005: Firebase Authentication (Google ソーシャルログイン基盤)
- ADR-010: フラットエラーレスポンス形式
- ADR-026: Google Workspace 連携 (DWD) — 本 ADR は DWD ではなく per-user OAuth を使用
- ADR-028: InMemoryDataSource テスト戦略 (Gmail API のみモック)
- ADR-030: 認証・認可・テナント解決分離
- ADR-032: Phase 1 採択 (PDF 生成ロジックの再利用元)
- ADR-033: Rejected (SMTP relay 案、不採用)
- Issue #346: Phase 2 起票
- Phase 1 PR: #345 (マージ済)
