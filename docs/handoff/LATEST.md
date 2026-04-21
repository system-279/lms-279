# Session Handoff — 2026-04-21

## TL;DR

Issue #272 Phase 1.8 セキュリティ先行実装 PR #277 を作成・レビュー対応・CI green 済。マージ待ち。並行して設計と実装の構造的ギャップを発見 → Codex セカンドオピニオンで方針確定（案B + 案②）、Issue #278 / #279 に実装スコープを整理済み。**次セッションはフレッシュ AI に完全引き継ぎ可能**。Phase 1.1–1.3 の GCP Console 操作は引き続きユーザー側作業待ち。

## 🚀 次セッション開始時の必読手順

```bash
# 1. 状況復元
cat docs/handoff/LATEST.md

# 2. 方針確定済み Issue の確認（body に決定事項あり）
gh issue view 278  # 案B + 案② で確定、実装スコープ明記
gh issue view 279  # 案B 実装の prerequisite (本番棚卸し)

# 3. 現在の OPEN PR
gh pr list --state open
# PR #277: マージ待ち (Firestore 正規化 + ユーザー GCP 操作が prereq)
# PR #273: Draft (Phase 3 実装完了まで保留、設計意図通り)
```

実装着手順序（推奨）:
1. **Issue #279**（棚卸しスクリプト作成 → dry-run → ユーザー補正）
2. **PR #277 マージ**（並行で GCP Console External化、ユーザー作業）
3. **Issue #278 実装**（`/impl-plan` → TDD → Evaluator 分離）

---

## セッション成果物

### PR
| # | Title | State | CI | 次アクション |
|---|-------|-------|----|--------------|
| **#277** | fix(auth): allowed_emails 削除時のセッション即時失効とメール正規化統一 | OPEN (mergeable) | ✅ Lint/Type/Test/Build 全 PASS | デプロイ前 `normalize-allowed-emails.ts` 実行 → マージ |
| #273 | docs(adr): ADR-030/031 Draft | DRAFT | ✅ | Phase 3 実装完了まで Draft 維持（元々の設計意図） |

### PR #277 変更内訳 (12 files, +848/-87)
**実装**:
- `services/api/src/services/auth-revoke.ts` (新規): Firebase refresh token 即時失効ヘルパー。AUTH_MODE=firebase のみ実アクション、dev は no-op。`getUserByEmail` と `revokeRefreshTokens` の try/catch 分離で race 時の握りつぶし回避
- `services/api/src/routes/shared/allowed-emails.ts`: POST 正規化 + DELETE で revoke 呼び出し (logger.error でエラー記録)
- `services/api/src/routes/shared/users.ts`: DELETE を `allowed_email → user → revoke` 順に変更。allowed_email 失敗時は 500 `deletion_partial_failure` を返し user を削除しない
- `services/api/src/middleware/tenant-auth.ts`: `verifyIdToken(idToken, true)` で revoke 後 ID token を拒否。`decodedToken.email` を `.trim().toLowerCase()` 正規化。`handleTenantAccessDenied` のレスポンス message を固定文言に一般化 (ユーザー列挙防止、logger.warn/auth_error_logs には詳細保持)
- `services/api/src/datasource/{in-memory,firestore}.ts`: `isEmailAllowed` / `deleteAllowedEmailByEmail` のクエリ引数正規化
- `scripts/normalize-allowed-emails.ts` (新規): 既存 Firestore データの正規化スクリプト (dry-run 既定 / `--execute` で反映)。`planNormalization` を純粋関数として export

**テスト** (+9 新規テスト / 4 ファイル新規):
- `auth-revoke.test.ts` (新規): AUTH_MODE 分岐 / 入力正規化 / revoke 自体の失敗再throw / user-not-found 分離
- `allowed-emails.test.ts` (新規): POST 正規化 / 409 重複 / 400 / DELETE + revoke / ベストエフォート / DataSource 正規化
- `users-delete-revoke.test.ts` (新規): 順序逆転 / 500 `deletion_partial_failure` / ベストエフォート
- `tenant-auth-error-response.test.ts` (新規): レスポンス一般化 / auth_error_logs 詳細保持 / logger.warn 検証
- `tenant-auth-firebase.test.ts` (新規): 大文字混在 decodedToken.email 正規化 / checkRevoked=true 呼び出し

### Issue 変動
| # | Title | 意味 |
|---|-------|------|
| **#278** (P0) | [ADR-031] allowed_emails の認可境界責務定義と既存 users 経路の再チェック | **2026-04-21 方針確定: 案B + 案②**。body に確定内容反映済 |
| **#279** (P0, 新規) | 本番 allowed_emails 棚卸しと差分補正 (#278 の前提) | Codex 指摘: 案B導入で既存 users が弾かれるリスクを防ぐ事前調査 |
| #272 (P0) | Phase 1 ユーザー操作待ち | 1.1 OAuth External化 / 1.2 Authorized Domains / 1.3 sayori-maeda@kanjikai.or.jp への再ログイン依頼 |
| #274/#275/#276 (P2) | Phase 5 実装 | #275-3 と #276-1 の **先行実装分は PR #277 に含まれている**。残り (監査ログ、Cloud Scheduler 化、管理画面UX等) は未着手 |

---

## 品質ゲート結果

| ゲート | 結果 |
|--------|------|
| `npm run lint` | ✅ PASS |
| `npm run type-check` | ✅ PASS (4 workspaces) |
| `npm run test` | ✅ API 425 / Web 33 = **458 tests PASS** (3回連続 green) |
| GitHub Actions CI | ✅ Lint/Type Check/Test/Build 全 PASS |
| Evaluator 分離プロトコル (rules/quality-gate.md) | ✅ AC 16 項目 PASS、HIGH/MEDIUM/LOW 対応済 |
| レビュー並列 (6 エージェント + Codex) | ✅ CRITICAL 2 / HIGH 4 / MEDIUM 対応済。H-B のみ Issue #278 に分離 |

---

## 次セッションの着手候補（優先度順）

### 🔴 最優先（ユーザー作業完了後すぐ）
1. **PR #277 マージ**
   - 事前: 本番 Firestore で `GOOGLE_APPLICATION_CREDENTIALS=... npx tsx scripts/normalize-allowed-emails.ts` を dry-run → 差分あれば `--execute`
   - マージ後: 本番で allowed_email 削除 → 該当ユーザーが即セッション失効することを確認
2. **Issue #272 Phase 1.1–1.3** (GCP Console 操作 → sayori-maeda さん再ログイン確認)

### 🟠 高優先（PR #277 マージ後）
3. **Issue #278**: ADR-031 改訂 + tenant-auth.ts の既存 users 再チェック追加
   - 案A/案Bの責務選択が必要（ユーザー判断）
   - 選択後 `/impl-plan` で実装計画
4. **Issue #272 Phase 3**: GCIP 移行実装 (別セッション `/impl-plan` 予定、別PR分割)

### 🟡 中優先（Phase 5）
5. Issue #276: allowed_emails 削除時の Cloud Scheduler 化 + GCIP Tenant 対応
6. Issue #275: 管理画面UX (登録プレビュー / 二者承認 / エラー統一の残り)
7. Issue #274: 運用可視化 (監査ログ / 定期棚卸 / break-glass)

### 🟢 副次 (いつでも)
8. scripts/ workspace 化 → CG-4 (`normalize-allowed-emails.test.ts`) の test 基盤
   - `planNormalization` は既に export 済なので、workspace 整備だけで有効化可能

---

## ブロッカー / ユーザー側タスク

| 項目 | 内容 | 影響 |
|------|------|------|
| GCP Console: OAuth 同意画面 External 化 | Issue #272 Phase 1.1 — **Firebase Auth は basic scopes (openid/email/profile) のみのため審査不要、Published 即時反映**。DWD の sensitive scopes (drive/docs/sheets) は SA 認証で OAuth 同意画面を経由しないため影響外 | sayori-maeda@kanjikai.or.jp のログイン復旧 |
| Firebase Console: Authorized Domains 確認 | Issue #272 Phase 1.2 — Codex 判断で skip 推奨だが確認のみ | 同上 |
| 本番 Firestore で `normalize-allowed-emails.ts` dry-run / execute | PR #277 マージ前 | 既存大文字混入データの救済 |
| ~~Issue #278 の責務選択 (案A / 案B)~~ → **案B + 連動削除案②で確定** (Codex 2nd opinion 2026-04-21) | 実装スコープ詳細は Issue #278 のコメント参照 | 次セッションで本番棚卸し → PR #277 マージ → #278 実装の順 |

**ドメイン縛りについて**: ADR-031 で「allowed_emails 純化 / ドメイン縛り不採用」確定済。External 化により Firebase Auth 側のドメイン制限（`hd` claim / GCIP Allowed Domains 等）も一切使わず、認可境界は allowed_emails 1 本に統一。→ ドメイン縛りは完全消滅。

---

## 作業ブランチ状態

```
fix/allowed-emails-security-hardening (PR #277, OPEN, mergeable, CI green)
  ├─ ee2c042 fix(auth): allowed_emails削除時のセッション即時失効とメール正規化統一
  └─ 11247a4 fix(auth): レビュー対応 - CRITICAL/HIGH 指摘と追加テスト

feat/adr-030-031-gcip-multi-tenancy (PR #273, DRAFT, Phase 3 まで保留)
```

main push なし、destructive 操作なし。ブランチ clean。

---

## 参考: このセッションで使った規範 / スキル

- `rules/quality-gate.md` — Evaluator 分離プロトコル (5ファイル以上の変更で発動)
- `rules/error-handling.md` §1 — 「状態復旧 > ログ記録 > 通知」で users.ts の順序逆転
- `rules/error-handling.md` §3 — transient/permanent 分類（auth/user-not-found は permanent 扱い、revoke race はその他エラーとして再throw）
- `rules/testing.md` §6 — AAA / 自己完結 / 1テスト1検証 / モック最小化
- `rules/production-data-safety.md` §1 — 今回は create/delete のみで Partial Update なし、対象外
- `rules/browser-operations.md` — 今回ブラウザ操作なし、対象外
- CLAUDE.md「Executing actions with care」— PR マージはユーザー承認待ちで停止
- `/review-pr` (pr-review-toolkit:review-pr) — 6エージェント並列 + Codex セカンドオピニオン
- `mcp__codex__codex` — 設計論レビュー（H-A / H-B 発見）
