# Session Handoff — 2026-05-19 (Session 35)

## TL;DR

**現場フィードバック対応セッション 2 連続（福の種テナント atali82i ログイン不可調査）。** 福の種様から「ユーザー管理画面のメールアドレスは正しいのに 2 名がログインできない」との連絡を受け、サーバー側の状態を read-only audit で切り分け → tenant 配下の `users` / `allowed_emails` / `auth_error_logs` を本番 Firestore に直接 read。**結論: サーバー側は正規登録済み、直近 30 日で tenant 全体に拒否ログ 0 件**。原因はクライアント側 or URL 到達前と確定。福の種様への返信文案を提示し本田さん承認、送付準備中（送付は decision-maker 領分）。

- **Issue Net**: **0** (起票 0 / Close 0)
- **Open 推移**: Session 34 末 6 件 → Session 35 末 **6 件** (変化なし)
- **マージ済み PR (2 本)**: #430 (audit-allowlist-status workflow, +682/-0), #431 (audit-tenant-auth-errors workflow, +530/-0)
- **本番反映**: ✅ 両 workflow とも main にマージ済、read-only のため Cloud Run デプロイ不要
- **調査結果**: 該当 2 email (`y-mizuno@fuku-no-tane.com` / `c-yazawa@fuku-no-tane.com`) ともに `users` / `allowed_emails` 正規登録済み、firebaseUid 未紐付け（初回ログイン未完了）、直近 30 日の拒否ログ 0 件

## 🚀 次セッション開始時の必読手順

```bash
# 1. 状況復元
cat docs/handoff/LATEST.md

# 2. main 最新と CI 状況
git fetch origin main && git log --oneline -10 origin/main
gh run list --branch main --limit 5

# 3. 現在の OPEN Issue (6 件、Session 34 から不変)
gh issue list --state open --limit 15

# 4. 次の着手候補:
#    A. 【ユーザー判断・最優先】福の種様への返信送信状況確認 + 返信受領時の追加切り分け
#       - 返信文面は Session 35 で本田さん承認済（本ファイル末尾）
#       - スクショ・URL・ブラウザ情報を受領後、原因切り分け継続
#    B. 【active Issue】#424 PATCH /quiz-attempts セッション再確認の abandoned 未対応
#    C. 【active Issue】#425 Firestore transient エラー用リトライ共通ユーティリティ
#    D. 【postponed・着手不可】#276 / #275 / #274 / #405 — 明示指示なき限り着手不可

# 5. 福の種様調査の再 audit が必要な場合（参考コマンド）
gh workflow run audit-allowlist-status.yml \
  -f tenant_id=atali82i \
  -f emails="y-mizuno@fuku-no-tane.com,c-yazawa@fuku-no-tane.com" \
  -f since_hours=720

gh workflow run audit-tenant-auth-errors.yml \
  -f tenant_id=atali82i \
  -f since_hours=720 \
  -f email_filter_domain=fuku-no-tane.com
```

---

## セッション成果物 (2026-05-19 Session 35)

### 🟢 PR #430 マージ: 特定 email の登録状態確認 audit (read-only)

- マージコミット: `1db86e9` (squash)
- ファイル: 3 (script + smoke test + workflow yaml)
- 差分: +682 / -0
- CI: Build / Lint / Type Check / Test 4/4 PASS

#### 構成
- `scripts/audit-allowlist-status.ts`: 入力 email 配列について `users` / `allowed_emails` / `auth_error_logs` の状態を表示、純粋関数 `parseEmails` / `computeDiagnosis` / `buildPerEmailReport`
- `scripts/__tests__/audit-allowlist-status.smoke.ts`: 14 ケース全 PASS
- `.github/workflows/audit-allowlist-status.yml`: workflow_dispatch + WIF、inputs は env 経由（command injection 対策）

#### 診断ロジック（優先順位）
1. `recent_auth_error_reason=<reason>`: 直近の auth_error_logs から reason 取得（最優先）
2. `user_not_found_in_users_collection`
3. `allowed_email_case_or_whitespace_mismatch`: 完全一致なし + ケース違いあり
4. `not_in_allowlist_suspected`: allowed_emails に該当なし
5. `no_firebase_uid_yet_user_has_not_logged_in`: 登録あるが初回ログイン未完了
6. `no_recent_auth_error_logs_user_may_have_other_issue`: 全て揃っているがログなし

### 🟢 PR #431 マージ: tenant 全体 auth_error_logs 集計 audit (read-only)

- マージコミット: `242e3e7` (squash)
- ファイル: 3 (script + smoke test + workflow yaml)
- 差分: +530 / -0
- CI: Build / Lint / Type Check / Test 4/4 PASS

#### 構成
- `scripts/audit-tenant-auth-errors.ts`: tenant 配下 auth_error_logs を直近 N 時間で取得、reason 別件数 + (domain 指定時のみ) email 別件数を集計、純粋関数 `aggregateLogs`
- `scripts/__tests__/audit-tenant-auth-errors.smoke.ts`: 7 ケース全 PASS
- `.github/workflows/audit-tenant-auth-errors.yml`: workflow_dispatch + WIF
- email 別表示は `email_filter_domain` 指定時に限定（不特定多数 email 漏洩防止）

### 🔍 調査結果（本番 atali82i tenant 直接 read）

#### PR #430 audit-allowlist-status 実行（since_hours=72 → 720 で 2 回）
| 項目 | 髙良 佑風 (`y-mizuno@fuku-no-tane.com`) | 矢澤 知穂 (`c-yazawa@fuku-no-tane.com`) |
|------|---|---|
| `users` 登録 | ✅ id=Vw3L7CfCVIm9Q4s9j4Hr, role=student, name="髙良　佑風" | ✅ id=GlB07XM5JxVF2yW4xcs7, role=student, name="矢澤　知穂" |
| `allowed_emails` 登録 | ✅ id=rl1RiPRXEZb9SiXn89e8 | ✅ id=vIXJLnZoI11lFM5Z13E8 |
| `firebaseUid` 紐付け | ❌ 未紐付け | ❌ 未紐付け |
| 直近 30 日 `auth_error_logs` | **0 件** | **0 件** |
| 診断 | `no_firebase_uid_yet_user_has_not_logged_in` | `no_firebase_uid_yet_user_has_not_logged_in` |

#### PR #431 audit-tenant-auth-errors 実行（since_hours=720, domain=fuku-no-tane.com）
- 取得件数: **0 件**
- reason 別件数: (該当ログなし)
- email 別件数 (fuku-no-tane.com): unique=0、(該当 domain での拒否ログなし)

#### 確定事項
1. サーバー側登録は両者とも完全に正常（ログイン受け入れ可能な状態）
2. 該当 2 email のログイン試行はサーバーまで一切到達していない（30 日間 0 件）
3. **別 email で試している可能性は否定**（fuku-no-tane.com domain で他 email の拒否ログも 0 件）
4. **tenant 全体で 30 日拒否ログ 0 件**（他テナント user も初回ログインを試みていない or 既ログイン継続）

### 📨 福の種様への返信文案（本田さん承認済、送付準備中）

```
福の種様

ご連絡ありがとうございます。サーバー側で 2 名様の登録状況を確認しましたが、
いずれもメールアドレスは正規に登録済みで、ログイン可能な状態でした。直近
30 日のサーバー側ログを確認しましたが、2 名様によるログイン試行が一度も
システム側で記録されていない状況です。

お手数ですが、原因切り分けのため下記をご教示ください:
1. ログインのどのステップで止まっておられるか（URL を開く / ログインボタンを
   押す / Google の画面が出る / アカウント選択する / その後の画面 — のどの段階か）
2. 画面のスクリーンショット（特にエラー表示や、白画面のままの場合はその状態）
3. アクセスされている URL（https://web-3zcica5euq-an.a.run.app/atali82i/
   で始まる形になっているか）
4. ご利用のブラウザ（Safari / Chrome 等）と端末（PC / スマホ）

取り急ぎご報告まで。
```

---

## Issue Net 変化

- **Close 数**: **0 件**
- **起票数**: **0 件**
- **Net**: **0 件**

| Open Issue (Session 35 末、Session 34 末から不変) | ラベル | 状態 |
|---|---|---|
| #425 | enhancement, P2 | active (Session 34 起票、Firestore transient リトライ共通ユーティリティ) |
| #424 | bug, P2 | active (Session 34 起票、PATCH session 再確認の abandoned 未対応) |
| #405 | enhancement, P2, postponed | M365/Outlook/Proofpoint/Mimecast テナント追加 or 添付名問い合わせ |
| #276 | enhancement, P2, postponed | Phase 3 GCIP 完了 (#272 / 再評価期限 2026-10-24) |
| #275 | enhancement, P2, postponed | Phase 3 GCIP 完了 |
| #274 | enhancement, P2, postponed | Phase 3 GCIP 完了 |

**Net 0 の理由言語化**: 本セッションは現場 1-shot 問い合わせ（福の種様ログイン不可）を受けた調査セッション。原因がサーバー側に存在しないことが確定したため、追加 Issue 起票なし。read-only audit workflow 2 本は将来の同種問い合わせの調査効率化のための恒久ツールとして残置（feedback_firestore_prod_admin_via_workflow.md §「責務集約」観点では別 workflow 量産になるが、責務が異なるため許容）。Session 34 末の active 2 件 + postponed 4 件はそのまま継承。

---

## 構造的整合性チェック

| 変更内容 | 該当スキル | 状態 |
|---|---|---|
| 型・共有ロジック変更 | `/impact-analysis` | ⏭️ 対象外 (新規 admin script のみ、既存型/ロジックに影響なし) |
| 新規 API / コレクション追加 | `/check-api-impact` | ⏭️ 対象外 (API 追加なし、既存 Firestore コレクションを read のみ) |
| データフロー追加 | `/trace-dataflow` | ⏭️ 対象外 (新規データフローなし) |
| statusField 状態遷移管理 | 状態遷移図 | ⏭️ 対象外 (read-only audit のみ) |
| Partial Update テスト | undefined 検出 | ⏭️ 対象外 (Firestore 書き込みなし) |

---

## ハーネス的考察（本セッション特有）

### 「すべて AI 側でチェック」明示指示時の workflow 経由 read-only 調査パターン

本田さんから「現場ヒアリングなしで AI 完結で原因切り分けしてほしい」との明示指示。本番 Firestore admin SDK アクセスは `feedback_firestore_prod_admin_via_workflow.md` に従い **ローカル `node -e` 直結ではなく workflow_dispatch + CI SA** で実行が原則。本セッションでこのパターンを LMS-279 で初確立:

| 構成要素 | 採用パターン |
|---|---|
| 認証 | WIF (workload_identity_provider) + CI SA (`github-actions@lms-279`) |
| 認証コード分岐 | JSON `type` field 判定（`service_account` → `cert()`、`external_account` → `applicationDefault()`、`cleanup-stuck-quiz-attempts.ts` 流用） |
| 入力 | workflow_dispatch inputs → env 経由（command injection 対策） |
| 出力規範 | PII 漏洩防止のため email 別表示は domain フィルタ指定時に限定、件数 + reason 集計を基本 |
| read-only 担保 | スクリプトに書き込み API なし、workflow に execute フラグなし |
| PR 単位 | 1 PR = 1 script + 1 workflow + 1 smoke test の責務集約セット |

Session 34 (`cleanup-stuck-quiz-attempts.yml` destructive write workflow) のパターンを read-only 版に転用。今後同種の「特定 email/tenant の本番状態を read-only で確認する」要件は本パターンで対応可能。

### 「読み書き 2 種類」の workflow 設計境界

本セッションで気づいた設計判断: **read-only audit と write migration を 1 workflow に詰め込まない**。理由:
- 入力に `execute` フラグを足すと「うっかり書き込み」リスクが残る
- read-only と write は責務 / 安全機構 / レビュー基準が異なる（書き込みには件数アサーション、バックアップ artifact、二段階運用が必要、read-only には不要）
- 1 PR = 1 責務で diff が小さく、レビュー精度が上がる

Session 34 で `cleanup-stuck-quiz-attempts.yml` を write 専用に設計、Session 35 で `audit-allowlist-status.yml` / `audit-tenant-auth-errors.yml` を read-only 専用として分離 → この境界が運用上のリスク低減に寄与。

### 「サーバー側で 0 件 = 試行が到達していない」という強い結論の取り方

直近 30 日 + tenant 全体 + domain 全 email で **拒否ログ 0 件** という結果は、サーバー側の問題ではないことを強く示唆する。`auth_error_logs` の網羅性（全 403 経路で 1 件以上書き込まれる設計、`tenant-auth.ts:138-168`）を確認した上で「サーバーまで届いていない」と結論できる。クライアント側の問題切り分けには現場ヒアリング（スクショ・URL・ブラウザ情報）が不可欠。AI 側で完結する調査の限界点として記録。

---

## 残タスク（次セッションへ）

### 即実施推奨
- 福の種様への返信送付状況確認 + 返信受領時の追加切り分け（本田さん領分、送付済 or 未送付）
- 現場情報受領後の原因特定（クライアント側 / URL / ブラウザ / 端末）

### Active Issue（Session 34 起票、本セッションでは未着手）
- #424 PATCH /quiz-attempts セッション再確認の abandoned 未対応 (bug, P2)
- #425 Firestore transient エラー用リトライ共通ユーティリティ (enhancement, P2)

### Postponed Issue（着手不可、明示指示なき限り保留）
- #276 / #275 / #274: Phase 3 GCIP 完了が再開条件（再評価期限 2026-10-24）
- #405: Phase 2 filename strict MTA risk

---

## 関連リンク

- PR #430: https://github.com/system-279/lms-279/pull/430 (audit-allowlist-status workflow)
- PR #431: https://github.com/system-279/lms-279/pull/431 (audit-tenant-auth-errors workflow)
- audit-allowlist-status run #1 (72h): https://github.com/system-279/lms-279/actions/runs/26075862372
- audit-allowlist-status run #2 (720h): https://github.com/system-279/lms-279/actions/runs/26075907026
- audit-tenant-auth-errors run (720h, fuku-no-tane.com): https://github.com/system-279/lms-279/actions/runs/26076156456
- Session 34 handoff (archived): docs/handoff/archive/2026-05-19-session-34.md
