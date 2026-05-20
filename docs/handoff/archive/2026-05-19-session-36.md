# Session Handoff — 2026-05-19 (Session 36)

## TL;DR

**受講者進捗 PDF Gmail 下書きの宛先ロジック改訂セッション。** 現場から「個人ごとの送付先が手動入力で誤送信リスクがある」との要望を受け、案 B (To=受講者本人 / CC=テナント管理者、CC は省略可) で改訂。Phase 2 元実装 (PR #358) は To=ownerEmail のみで、UI フロー (userId 指定) と宛先が不整合だった点を修正。Codex review (plan / code 各 1 回) + /simplify 3 並列 + /safe-refactor + Evaluator 分離プロトコル + Codex code review (実装後) の **5 段階品質ゲート** を全通過、AC 15/15 PASS、テスト 1062 件 PASS、CI success で squash merge 完了。

- **Issue Net**: **+3** (起票 4 件 / Close 1 件)
- **Open 推移**: Session 35 末 6 件 → Session 36 末 **9 件** (active 5 / postponed 4)
- **マージ済み PR**: #434 (受講者進捗 PDF Gmail draft 宛先改訂、12 files +789/-71)
- **新規 follow-up Issue**: #435 [P1] idempotency umbrella / #436 [P1] accessToken owner 検証 / #437 [P2] Gmail PII フィルタ — いずれも Phase 2 元実装 (PR #358) からの継承課題、Codex code review で rating ≥ 7 / triage #4 該当のため起票
- **本番反映**: ✅ main push 後 Cloud Run Deploy success (4m8s)

## 🚀 次セッション開始時の必読手順

```bash
# 1. 状況復元
cat docs/handoff/LATEST.md

# 2. main 最新と CI 状況
git fetch origin main && git log --oneline -10 origin/main
gh run list --branch main --limit 5

# 3. 現在の OPEN Issue (9 件: active 5 / postponed 4)
gh issue list --state open --limit 15

# 4. 次の着手候補:
#    A. 【ユーザー判断・最優先】福の種様への返信送信状況確認 + 返信受領時の追加切り分け
#       - 返信文面は Session 35 で本田さん承認済 (archive/2026-05-19-session-35.md 参照)
#       - スクショ・URL・ブラウザ情報を受領後、原因切り分け継続
#    B. 【新規 Issue 着手判断】(decision-maker 領分):
#       - #435 [P1] idempotency 非アトミック + 判定強化 umbrella
#       - #436 [P1] accessToken owner 検証
#       - #437 [P2] Gmail API エラーメッセージ PII フィルタ
#    C. 【active Issue】#424 PATCH /quiz-attempts セッション再確認の abandoned 未対応
#    D. 【active Issue】#425 Firestore transient エラー用リトライ共通ユーティリティ
#    E. 【postponed・着手不可】#276 / #275 / #274 / #405 — 明示指示なき限り着手不可

# 5. PR #434 後の動作確認 (必要なら本番で実施)
#    - /super/progress/[tenantId]/[userId]/print で「Gmail 下書き作成」を押下
#    - To=受講者本人 / CC=テナント管理者 (or 未設定なら CC 省略) が自動入力されることを確認
#    - 本文に「{userName} 様」呼びかけ + (ownerEmail 設定時のみ) CC 注記が含まれることを確認
```

---

## セッション成果物 (2026-05-19 Session 36)

### 🟢 PR #434 マージ: 受講者進捗 PDF Gmail 下書きの宛先を案 B に改訂

- マージコミット: `d8a151e` (squash)
- ファイル: 12 (実装 6 + テスト 5 + ADR 1)
- 差分: +789 / -71
- CI: Build / Lint / Type Check / Test 全 PASS、Deploy to Cloud Run 4m8s success

#### 改訂の核心 (旧 → 新)
| 項目 | 旧 (Phase 2 元実装) | 新 (案 B) |
|---|---|---|
| To 宛先 | `tenants/{tenantId}.ownerEmail` (テナント管理者) | `users/{userId}.email` (受講者本人) |
| CC 宛先 | (なし) | `tenants/{tenantId}.ownerEmail` (未設定なら CC ヘッダ省略) |
| UI/宛先整合 | ❌ UI は受講者単体だが宛先は管理者 | ✅ 整合 |
| ownerEmail 未設定挙動 | ❌ 400 で送信不可 | ✅ CC 省略で送信成功 |
| user.email 未設定挙動 | (チェックなし) | ✅ 400 `user_email_not_configured` |
| ヘッダインジェクション防御 | To のみ | ✅ To/CC 両方 |
| 本文呼びかけ | 「{userName} さん」 | 「{userName} 様」+ CC 設定時のみ注記 |
| 監査ログ | `ownerEmailHash` のみ | dual-write: `recipientToHash` / `recipientCcHash` + 旧 `ownerEmailHash` 維持 |

#### 主要変更ファイル
- `packages/shared-types/src/progress-pdf.ts`: エラーコード `user_email_not_configured` / `invalid_owner_email` 追加
- `services/api/src/services/gmail-draft.ts`: `cc?: string` 引数、MIME `Cc:` 行、CRLF/サロゲート assert を CC にも適用
- `services/api/src/routes/super/progress-pdf-draft.ts`: `validateRecipientEmail` (5 拒否理由 + 形式チェック) + To/CC ロジック改修
- `services/api/src/services/progress-pdf-mail-template.ts`: 「{userName} 様」呼びかけ + ownerEmail 有時のみ CC 注記 (虚偽記載防止)
- `services/api/src/services/pdf-draft-audit.ts`: dual-write (`recipientToHash` / `recipientCcHash` 追加、`ownerEmailHash` 残置)
- `web/app/super/progress/[tenantId]/[userId]/print/page.tsx`: 宛先 (To) / CC 表示、disable 条件を `userEmail.trim()` 空に変更
- `docs/adr/ADR-034-phase2-gmail-draft.md`: §2 図 / §5 宛先 / §7 監査ログ / §8 エラー改訂 + 改訂履歴セクション追加

#### Acceptance Criteria (15 件、全 PASS)

| # | 内容 | 検証 |
|---|---|---|
| AC-1 | To=user.email (trim 後) が MIME に入る | 統合 + gmail-draft 単体 |
| AC-2 | ownerEmail 設定済なら CC: に入る | 統合 + gmail-draft 単体 |
| AC-3 | ownerEmail null/空文字なら CC 省略で送信成功 | 統合 (3 ケース) |
| AC-4 | user.email 未設定/空白なら BE 400 + FE disabled | 統合 + FE component |
| AC-5 | CC への CRLF インジェクション拒否 | gmail-draft 単体 |
| AC-6 | 監査ログに recipientToHash / recipientCcHash 記録 | audit + 統合 |
| AC-7 | 既存 Phase 2 元 AC 退行なし | 既存テスト 47 件 PASS 維持 |
| AC-8 | FE 画面に「宛先 (To) / CC」表示 | FE component |
| AC-9 | mail-template の「{userName} 様」+ ownerEmail 時のみ CC 注記 | mail-template 単体 |
| AC-10 | user.email が trim 後空 / CRLF / カンマ / 制御文字含みなら 400 | 統合 (5 ケース) |
| AC-11 | ownerEmail null/空でも本文 CC 注記省略 (虚偽記載防止) | mail-template + 統合 |
| AC-12 | ownerEmail が CRLF/カンマ/制御文字なら 400 invalid_owner_email | 統合 (3 ケース) |
| AC-13 | 旧スキーマ idempotency ログでも 200 を返す | 統合 |
| AC-14 | raw email は保存されずハッシュのみ | audit |
| AC-15 | FE は userEmail trim 空で disabled、ownerEmail 未設定では disabled にしない | FE component |

#### 品質ゲート実績 (5 段階)

| 段階 | 結果 |
|---|---|
| Codex plan review (impl-plan 段階) | Important 7 件反映 + 追加 AC 6 件採用 → 計 15 AC |
| `/simplify` (3 並列 agent: reuse / quality / efficiency) | Critical 0 件、Important 6 件反映 |
| `/safe-refactor` | MEDIUM 1 件容認 (バリデーション失敗時の Firestore 監査ログ非書込 → 既存方針との整合性) |
| Evaluator 分離プロトコル (別 context Claude) | AC 15/15 PASS、Important 3 件反映 |
| Codex code review (実装後) | Critical 0 件 / High 2 件 / Medium 4 件 — **全て Phase 2 元実装 (PR #358) 継承課題で本 PR スコープ外**、follow-up Issue 3 件として起票 |

### 🟠 Follow-up Issue 起票 3 件 (Codex code review で検出された Phase 2 元実装継承課題)

#### #435 [P1 enhancement] idempotency 非アトミック + 判定強化 umbrella (H1 + M1 + M2)
- 現状 `get → Gmail draft 作成 → set` の 3 段階で、同一 requestId の並行リクエストが両方 `exists=false` を見て二重作成可能
- 解決策案: `pending` を `create()` で先取り or Firestore transaction でロック
- 追加: idempotency 判定が status + draftId のみで、userId / 宛先 hash を見ない
- 追加: idempotency 確認失敗時のフォールスルーで Firestore 障害時に重複 draft

#### #436 [P1 enhancement/security] Gmail draft の accessToken owner 検証 (H2)
- 現状、accessToken の Google アカウント所有者と superAdmin.email の一致を BE で検証していない
- API 直叩きで別 Google アカウントの token を渡すと、その mailbox に draft 作成可能 → 監査ログ信頼性低下
- 解決策案: `oauth2.tokeninfo` で token owner email 取得 → superAdmin.email と一致しない場合 403

#### #437 [P2 enhancement/security] Gmail API エラーメッセージ PII フィルタ (M4)
- Gmail API の raw `message` が logger.error + HTTP レスポンスに流れる
- response.data.error.message に宛先 / MIME 断片 / アカウント情報が含まれる可能性 → PII 漏洩リスク
- 解決策案: GmailDraftError を internal/public message に分離

### 📐 ADR-034 改訂内容
- Status: **Proposed → Accepted** (PR #358 で実装済、本セッションで案 B 改訂)
- 改訂履歴セクション追加 (2026-05-19 改訂、Issue #433)
- §2 アーキテクチャ図: To/CC 二段化
- §5 宛先決定: 案 B 採用理由マトリクス + バリデーションルール (5 拒否理由) 追記
- §7 監査ログスキーマ: dual-write 戦略 (recipientToHash / recipientCcHash / 旧 ownerEmailHash) 明文化
- §8 エラー分類テーブル: 新 2 エラーコード + 旧 owner_email_not_set (deprecated) 注記

---

## Issue Net 変化

- **Close 数**: **1 件** (#433)
- **起票数**: **4 件** (#433 / #435 / #436 / #437)
- **Net**: **+3 件**

| Open Issue (Session 36 末、9 件) | ラベル | 状態 |
|---|---|---|
| #437 | enhancement, P2 | active (本セッション起票、Gmail PII フィルタ) |
| #436 | enhancement, P1 | active (本セッション起票、accessToken owner 検証) |
| #435 | enhancement, P1 | active (本セッション起票、idempotency umbrella) |
| #425 | enhancement, P2 | active (Session 34 起票、Firestore transient リトライ共通ユーティリティ) |
| #424 | bug, P2 | active (Session 34 起票、PATCH session 再確認の abandoned 未対応) |
| #405 | enhancement, P2, postponed | M365/Outlook/Proofpoint/Mimecast テナント追加 or 添付名問い合わせ |
| #276 | enhancement, P2, postponed | Phase 3 GCIP 完了 (#272 / 再評価期限 2026-10-24) |
| #275 | enhancement, P2, postponed | Phase 3 GCIP 完了 |
| #274 | enhancement, P2, postponed | Phase 3 GCIP 完了 |

**Net +3 の理由言語化**: 本 PR #434 は宛先ロジック改訂 1 件で #433 を close したが、Codex code review (実装後) で **Phase 2 元実装 (PR #358) からの脆弱性 3 件** が新規可視化された:
- idempotency 非アトミック (PII 重複 + Gmail quota 消費リスク)
- accessToken owner 不一致 (監査ログ信頼性)
- Gmail エラーメッセージ PII 漏洩

いずれも本 PR スコープ外 (宛先ロジックは Critical/High なし、5 段階品質ゲートで検証済)。CLAUDE.md triage 基準 #4 (rating ≥ 7 / confidence ≥ 80) を確実に満たすため起票。**過剰起票ではなく、隠れていた脆弱性を可視化した価値と引き換えの Net 逆行**。decision-maker による着手優先度判断材料が増えた状態。

---

## 構造的整合性チェック

| 変更内容 | 該当スキル | 状態 |
|---|---|---|
| 型・共有ロジック変更 | `/impact-analysis` | ✅ type-check 全 4 workspace PASS で integration 担保 (shared-types ProgressPdfDraftErrorCode 追加は FE/BE 両方で型強制) |
| 新規 API / コレクション追加 | `/check-api-impact` | ⏭️ 対象外 (既存 endpoint `/progress-pdf-draft` の挙動変更のみ、新規 endpoint なし) |
| データフロー追加 | `/trace-dataflow` | ⏭️ 対象外 (既存 `ProgressPdfData` の `user.email` を新規利用、データソースは Phase 1 から再利用) |
| statusField 状態遷移管理 | 状態遷移図 | ⏭️ 対象外 (status は draft 1 状態) |
| Partial Update テスト | undefined 検出 | ⏭️ 対象外 (監査ログは新規 set のみ、Partial Update なし) |

---

## ハーネス的考察 (本セッション特有)

### 5 段階品質ゲートの実効性

本セッションで初めて **5 段階品質ゲート (Codex plan / simplify / safe-refactor / Evaluator / Codex code review)** を 1 PR で全実施。各段階の付加価値は重複しなかった:

| 段階 | 役割 | 本 PR での実効指摘 |
|---|---|---|
| Codex plan review | 計画段階の設計レビュー | Important 7 件 + 追加 AC 6 件 (実装前のスコープ拡張) |
| /simplify (3 並列) | reuse / quality / efficiency の 3 観点同時 | hashEmail 重複削減、3 段ネスト解消、reason 露出削除など 6 件 |
| /safe-refactor | 型安全性 / エラー処理 | MEDIUM 1 件 (既存方針整合のため容認) |
| Evaluator (別 context) | AC 検証 + 第三者視点 | AC 15/15 PASS、validatedToEmail null 初期化など 3 件 |
| Codex code review (実装後) | 別モデル視点でセキュリティ・後方互換 | High 2 / Medium 4 全て本 PR スコープ外の Phase 2 元実装継承課題 → follow-up Issue 化 |

特に **Codex code review が「実装後の別モデル視点」として Phase 2 元実装の脆弱性 3 件を可視化** したのは収穫。Claude 系の 4 段階レビュー (simplify / safe-refactor / Evaluator / Codex plan) では捕捉できなかった「実装スコープ外の関連既存課題」を補完する役割を果たした。

### case B 採用判断の構造 (UI/宛先整合の発見)

ユーザーから「個人ごとの送付先が手動」との 1 段階目フィードバック → 私が「実は実装済」と返答 → ユーザーが画像で「個人ごとの Gmail 確認した」と再確認 → 私が「UI 単位は受講者なのに宛先は管理者で不整合」を指摘 → ユーザーが「最適解な予感」で案 B を提示 → 採用確定。

この対話パターンは「**現場の表面要望を技術設計の整合性まで掘り下げる Socratic 進行**」として記録すべきと判断。`/brainstorm` skill の本来の用途と一致。

### Follow-up Issue 3 件起票判断 (CLAUDE.md GitHub Issues #5 / triage #4)

本 PR の Codex code review で Phase 2 元実装 (PR #358) の脆弱性 3 件を可視化したが、これらは本 PR スコープ外。以下の選択肢を比較:

1. ❌ 本 PR で全て fix → スコープ拡大、レビューやり直し、merge 遅延
2. ✅ 別 Issue で起票 → 1 PR 1 目的、追跡性確保、decision-maker が優先度判断
3. ❌ Issue 化せず TODO コメントだけ → 隠れて忘れられるリスク

→ 案 2 採用。Codex review rating ≥ 7 / confidence ≥ 80 で triage 基準 #4 該当のため、ユーザー明示認可を得て起票。Net +3 は handoff KPI 逆行だが、隠れていた脆弱性を可視化した価値と引き換え。

---

## 残タスク (次セッションへ)

### 即実施推奨
- 福の種様への返信送付状況確認 + 返信受領時の追加切り分け (本田さん領分、Session 35 から継続)
- PR #434 実装の本番動作確認 (decision-maker 領分、Cloud Run デプロイ済)
  - スーパー管理者ログイン → `/super/progress/[tenantId]/[userId]/print` → Gmail 下書き作成 → To/CC の自動入力確認

### Active Issue (本セッション起票、優先度判断要)
- #435 [P1] idempotency 非アトミック + 判定強化 umbrella (本番障害リスク中)
- #436 [P1] accessToken owner 検証 (監査信頼性 + API 直叩き抜け穴)
- #437 [P2] Gmail API エラーメッセージ PII フィルタ (PII 漏洩リスク中)

### Active Issue (Session 34 起票、未着手)
- #424 PATCH /quiz-attempts セッション再確認の abandoned 未対応 (bug, P2)
- #425 Firestore transient エラー用リトライ共通ユーティリティ (enhancement, P2)

### Postponed Issue (着手不可、明示指示なき限り保留)
- #276 / #275 / #274: Phase 3 GCIP 完了が再開条件 (再評価期限 2026-10-24)
- #405: Phase 2 filename strict MTA risk

---

## 関連リンク

- PR #434: https://github.com/system-279/lms-279/pull/434 (受講者進捗 PDF Gmail draft 宛先案 B 改訂)
- Issue #433 (closed): https://github.com/system-279/lms-279/issues/433
- Issue #435 (active): https://github.com/system-279/lms-279/issues/435 (idempotency umbrella)
- Issue #436 (active): https://github.com/system-279/lms-279/issues/436 (accessToken owner 検証)
- Issue #437 (active): https://github.com/system-279/lms-279/issues/437 (Gmail PII フィルタ)
- ADR-034 (Accepted): docs/adr/ADR-034-phase2-gmail-draft.md
- Cloud Run Deploy run: https://github.com/system-279/lms-279/actions/runs/26100557179
- Session 35 handoff (archived): docs/handoff/archive/2026-05-19-session-35.md
