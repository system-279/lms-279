# ADR-031: Google Cloud Identity Platform マルチテナント採用

## ステータス
ドラフト（2026-04-21起票、未承認）

## コンテキスト
2026-04-21、外部ドメインユーザー（kanjikai.or.jp）がログインできないインシデントが発生。根本原因はGCP OAuth同意画面の `orgInternalOnly: true` 設定で、279279.net以外のユーザーが認証経路に入れない状態だった。

暫定対応として OAuth 同意画面を External 化した（ADR-030 レイヤー1の変更）が、以下の課題が残る:
- 全世界のGoogleアカウントがFirebase Authにユーザー作成可能となり、「所属テナントなし」の孤児ユーザーが蓄積する
- Firebase Auth（非マルチテナント版）はテナント単位の認証サイロを持たない（UID空間・セッション・監査ログが全テナント共通）

マルチテナントLMSとして、**テナントごとに独立した認証サイロ**を持つ設計が本筋である。

なお、本システムのアクセス制御は ADR-006 で定義された **allowed_emails ホワイトリストを唯一の認可境界** とする方針を継続する。Codex セカンドオピニオン（2026-04-21）の検証により、ドメイン単位の絞り込みは本システムの設計思想と整合しない（ホワイトリストが既にゼロトラスト境界として機能しており、ドメイン縛りの多重化はむしろ運用ミスの温床）と判断し、**ドメイン縛りは採用しない** ことを本ADRで確定する。

## 決定
Firebase Authentication を Google Cloud Identity Platform（GCIP）のマルチテナントにアップグレードし、各テナントに GCIP Tenant を対応させる。

### 採用方針（本LMSの認証・認可の基本原則）
1. **allowed_emails（メール単位ホワイトリスト）を唯一の認可境界** とする（ADR-006 を継続・強化）
2. ドメイン単位の絞り込み（Google `hd` パラメータ / GCIP Allowed Domains / Firebase メールドメイン制御）は **採用しない**
3. GCIP 採用の主目的は **テナント単位の認証サイロ分離**（UID空間 / セッション / 監査ログ の完全分離）
4. 副次効果として将来の SAML/OIDC 対応の下地は得られるが、本ADRのスコープではない

### フェーズ定義
本ADRで言及する Phase 番号は以下に対応する（インシデント対応 Issue #272 の WBS と同期）:

| Phase | 内容 |
|-------|------|
| 1 | OAuth同意画面 External 化（暫定復旧） |
| 1.7 | 孤児Authユーザー掃除スクリプト雛形（`scripts/cleanup-orphan-auth-users.ts`） |
| 2 | 本ADR + ADR-030 起票（ドラフト） |
| 3 | GCIP移行実装（feature flag + カナリア） |
| 4 | Staging検証・本番ロールアウト |
| 5 | クリーンアップ・運用手順書整備（Cloud Scheduler正式化含む） |

### 移行戦略
1. **Identity Platform アップグレード**: Firebase プロジェクトで Identity Platform を有効化（SDK互換、既存UIDは保持される）
2. **GCIP Tenant の段階的作成**: 既存 Firestore `tenants/{tenantId}` に対応する GCIP Tenant を作成
3. **`tenants` スキーマ拡張**: `gcipTenantId: string | null` フィールド追加（nullableで後方互換）
4. **Feature flag `useGcip: boolean`**: テナント単位で GCIP 経路 / 旧 Firebase Auth 経路を切り替え
5. **FE ログインフロー変更**: `/[tenant]/` ルートでテナント情報を取得 → GCIP Tenant ID (`gcipTenantId`) を `auth.tenantId` にセット → `signInWithPopup`
6. **BE 検証強化**: `verifyIdToken` の戻り値 `decodedToken.firebase.tenant` は **GCIP Tenant ID**（URLパスの `tenantId` ではない）であり、これを Firestore `tenants/{tenantId}.gcipTenantId` と照合してテナント整合性を確認する
7. **カナリア展開**: 1テナントで動作確認 → テナント単位で段階展開 → 全テナント移行
8. **Feature flag 削除と旧経路除去**: 全テナント移行後

### allowed_emails 境界の必須条件
ホワイトリスト主義を徹底するため、以下を実装レベルの必須条件とする（Phase 3 までに全項目実装）:

1. **`decodedToken.email_verified === true` を必須化**（未検証メールでのログインを拒否）
2. **`decodedToken.firebase.sign_in_provider === "google.com"` のみ許可**（他 provider からのログインを拒否、将来拡張時は別ADRで明示的に許可）
3. **メール正規化は `.trim().toLowerCase()` のみ**（Gmail ドット無視・plus addressing は **適用禁止**。Google Workspace 独自ドメインで事故るため）
4. **認可単位は `(tenantId, email)` の組**（email 単独での認可判定は禁止）
5. **認可チェックは毎リクエスト実施**（キャッシュ依存禁止、削除後の既存セッションでアクセスが残るのを防ぐ）
6. **クライアントから Firestore 直接アクセスは引き続き禁止**（全アクセスは API 経由の Admin SDK のみ。Firestore Security Rules 不要）

### As-Is 実装状況（2026-04-22更新、Phase 3 補強対象の明示）
| 項目 | 現状 | Phase 3 必須対応 |
|------|------|-----------------|
| email_verified チェック | ✅ 実装済み（Issue #286 / PR #288: `findOrCreateTenantUser` + Issue #289: `superAdminAuthMiddleware` の 2 経路で必須化） | `help-role.ts` / `tenants.ts` 等の `verifyIdToken` 直接呼び出し箇所にも適用（後続 Issue） |
| sign_in_provider 制限 | ✅ 実装済み（Issue #286 / PR #288 + Issue #289: 上記 2 経路で `firebase.sign_in_provider === "google.com"` のみ許可） | 同上 |
| checkRevoked=true（即時失効） | ✅ 実装済み（B-1: `tenantAwareAuthMiddleware` + Issue #289: `superAdminAuthMiddleware` の 2 経路で `verifyIdToken(..., true)`） | 同上 |
| メール正規化（allowed_emails） | ✅ `.trim().toLowerCase()` で統一（PR #277 で route/middleware 層、Issue #278 / PR #284 で DataSource 層に拡張） | 維持 |
| メール正規化（users） | ✅ マイグレーションスクリプト実装済み（Issue #285 / PR #287: `scripts/normalize-users-email.ts`） | 本番 dry-run → 補正実施（Phase 3 着手前の前提作業） |
| (tenantId, email) 認可単位 | ✅ 実装済み（テナントスコープの allowed_emails） | 維持 |
| **認可チェック毎リクエスト実施** | ✅ **Issue #278 で対応済み**（既存 user 経路 4 箇所すべてに allowed_emails 再チェックを追加。スーパー管理者のみ例外） | 維持 |
| UID 紐付けの原子性 | 🟡 **未対応**（`getUserByEmail` → `updateUser({firebaseUid})` が非原子的。並行ログイン / GCIP UID 揺り戻しで last-write-wins） | **Phase 3 必須対応**: `email_verified` / provider 制限を先行実装したうえで compare-and-set 的な保護と監査ログを追加 |
| クライアント Firestore 直接アクセス禁止 | ✅ 実装済み（`web/` 配下で `firebase/firestore` import ゼロ） | 維持 |
| Custom Claims 利用 | ✅ 未使用（Claims 再発行問題なし） | 維持 |

> **適用スコープ注記**: 上記 ✅ は `tenantAwareAuthMiddleware` (`middleware/tenant-auth.ts`) と `superAdminAuthMiddleware` (`middleware/super-admin.ts`) の 2 経路に限定。`routes/help-role.ts` および `routes/tenants.ts` 冒頭には `verifyIdToken(idToken)` の直接呼び出しが残っており、同等ガードは未適用（後続 Issue で対応）。

> **Firestore 障害時の挙動 (Issue #293 / PR)**: `getSuperAdminsFromFirestore` は Firestore アクセス失敗時に空配列を silent に返していたため、env に未登録の super-admin が silent に 403 で締め出される「部分 fail-open + ユーザー欺瞞」状態だった。
> - 修正後: `SuperAdminFirestoreUnavailableError` を throw し、`superAdminAuthMiddleware`（super-admin 専用 endpoint）は 503 Service Unavailable で返却（env 高速パスで通過済みのケースはここに到達しない）
> - `tenantAwareAuthMiddleware#checkSuperAdmin` / `routes/help-role.ts` は既存の try/catch で障害を吸収し、従来どおり権限縮小して継続する（**セキュリティ境界として fail-open には戻らないが**、Firestore 登録 super-admin がテナント API / help 画面で一時的に通常ロール扱いになる silent UX degradation は残る。#292 等の後続 Issue で UX 改善検討）

### 認可境界と認証モードの関係（2026-04-22 明記）
| 認証モード | 認可境界の適用 |
|-----------|--------------|
| `firebase` | ✅ `allowed_emails` 毎リクエスト再チェック（本番想定） |
| `dev` x-user-email | ✅ 再チェック対象（production 同等に検証） |
| `dev` x-user-id | ✅ 再チェック対象（ヘッダ email を優先し、無ければ DB email を使用） |
| `dev` demo（`demoAuthMiddleware` が `req.user` をプリセット） | ⚠️ **バイパス**（tenant-auth は `req.user` 設定済みならスキップ）。DEMO_ENABLED は production で無効化する運用前提 |

### UID保持戦略
- GCIP Tenant ごとにユーザーサイロが分かれるため、新UIDが発行される
- `tenant-auth.ts` の `findOrCreateTenantUser` 関数内の **email ベースフォールバック検索** がテナント単位の DataSource 内で移行時の橋渡しをする:
  - GCIP経由のログインで新UID取得 → テナント内 `users` コレクションを email で検索 → `firebaseUid` フィールドを新UIDに上書き
- ただし、この処理は上記「必須条件 1, 2, 3」を満たしたトークンに対してのみ実施する
- 既存ユーザーが suspended 状態でないこと

### UID・メンバー識別戦略の補強
GCIP テナント単位で UID 空間が分離するため、以下を原則とする:

- 外部キーは **`(tenantId, firebaseUid)` または `(tenantId, memberId)` の組** で扱う（`firebaseUid` 単独でのグローバル参照は禁止）
- **email は「ログイン識別子」であり「人物識別子」ではない**（emailでJOINして同一人物と扱う設計は禁止）
- As-Is 調査: `firebaseUid` 参照は8ファイル（`tenant-auth.ts` / `super-admin.ts` / `tenants.ts` / `auth.ts` / `entities.ts` / `in-memory.ts` / `firestore.ts` / `super-admin.ts`）
- Phase 3 実装時に上記8ファイルの各参照箇所が `(tenantId, firebaseUid)` の組で扱われているかを評価し、グローバル参照している箇所を修正

### ロールバック戦略
- `useGcip: false` にすれば旧経路に戻る（feature flag）、`gcipTenantId` は nullable で残す
- 移行期間中、両経路が同時稼働可能
- **UID 揺り戻しリスク**: GCIP ログイン時に `firebaseUid` を新UIDへ上書きするため、ロールバック後は旧 Firebase Auth UID で再度上書きされる（email fallback で復旧可能だが UID 参照の揺れが発生）
  - 監査ログ上の UID 参照
  - 外部連携（Cloud Logging、BigQuery export、分析ダッシュボード）の UID 参照
  - アクティブセッション（ロールバック時はユーザーに再ログイン要求）
- 上記の影響を許容できるテナント単位でのみ段階的にロールバックを実施する

## 根拠
- **責務分離（ADR-030）**: テナント=認証サイロの1:1対応により、認証レイヤーもマルチテナント化
- **UID保持リスクの低さ**: 影響範囲は `firebaseUid` フィールド1箇所のみ。Custom Claims未使用
- **拡張性**: 将来的にテナントごとのSAML/OIDC連携（大手顧客SSO要件）に対応可能
- **セキュリティ**: テナント単位で Sign-in providers、MFA方針を独立設定（Allowed Domains によるドメイン絞り込みは採用方針により不採用）
- **Codexセカンドオピニオン（2026-04-21、2回実施）**: 段階移行、feature flag、カナリア展開を推奨。さらにホワイトリスト主義採用時の必須条件（email_verified・provider制限・メール正規化・(tenantId,email)認可単位・キャッシュ依存禁止）を指摘、本ADRに反映済

## 影響
### コード変更
- `services/api/src/middleware/tenant-auth.ts`: テナント整合性チェック追加
- `services/api/src/routes/tenants.ts`: 新規テナント作成時に GCIP Tenant 自動作成
- `web/lib/auth-context.tsx`: `auth.tenantId` 設定ロジック追加
- `web/app/[tenant]/page.tsx`: ログイン前のテナント解決
- Firestore `tenants` スキーマ: `gcipTenantId`, `useGcip` フィールド追加

### 運用変更
- GCP コンソールで GCIP Tenant 管理（新規テナント作成・削除手順の更新）
- 週次チェック: 孤児Authユーザー → 本ADRリリースと同時に追加された `scripts/cleanup-orphan-auth-users.ts` を Phase 5 で Cloud Scheduler 経由の定期実行に正式化
  - **既知の制約**: 現状の掃除スクリプトは `getAuth()` のデフォルトインスタンスのみを対象とし、GCIP Tenant 配下のユーザーは対象外。Phase 3 実装時に `tenantManager().authForTenant(gcipTenantId)` 対応を追加する（Phase 5 までの暫定制約）
- 監視: GCIP ログイン成功率・エラー率を Cloud Logging で計測

### 運用必須施策（Phase 5 までに整備、Issue 単位で分解）
ドメイン縛りを採用しない代償として、allowed_emails 運用の堅牢化が必須となる（Codex セカンドオピニオン 2026-04-21 の指摘に基づく）:

- **変更監査ログ**: allowed_emails の追加・削除ごとに「誰が・いつ・理由・対象テナント」を記録
- **登録時プレビュー**: 管理画面で対象の表示名・Google account email・テナント・ロールを視覚的に確認してから確定
- **重要テナントの二者承認**: admin が複数いるテナントでは、1人の admin 追加時にもう1人の承認を要求
- **削除時の即時セッション失効**: allowed_emails 削除時に該当ユーザーのアクティブセッションを無効化（Firebase Auth の `revokeRefreshTokens` 利用）
- **定期棚卸し**: 四半期ごとに全テナントの allowed_emails を棚卸しし、退職者・離任者の削除漏れを検出
- **エラーメッセージ設計**: 「所属するテナントがありません」で統一し、メール存在確認に使えない設計を維持（ユーザー列挙防止）
- **break-glass 管理者の別管理**: 緊急アクセス用の管理者アカウントは通常の allowed_emails とは別に管理し、使用時に強制的に監査ログとアラートを発生させる

### External 化の副作用と緩和策
OAuth 同意画面 External 化（Phase 1）により、全世界の Google アカウントが認証試行可能になる:

| 副作用 | 緩和策 |
|--------|--------|
| 未許可ログイン試行の増加 | Phase 1.7 孤児 Auth 週次掃除 + Cloud Logging での試行監視 |
| ユーザー列挙リスク | エラーメッセージを「所属するテナントがありません」で統一 |
| ログノイズ増加 | Cloud Logging フィルタで「所属テナントなし」の頻度を週次集計 |
| サポート問い合わせ増加 | ランディング画面に「アクセスには管理者の登録が必要」の案内を明示 |
| 削除後の既存セッション継続 | 削除時の `revokeRefreshTokens` 即時実行（運用必須施策参照） |

### 費用影響
- GCIP のマルチテナント機能（Identity Platform Tenants）は **Identity Platform の特定 Tier（Essentials 以上）** で提供される
- 料金体系は公式ドキュメントで常に変動し得るため、**Phase 3 実装着手前に GCP コンソールで現行プランを再確認**すること
- 現状 Firebase Auth は無料枠で運用中。GCIP移行後の費用は Tier とMAU次第で数千円〜数万円/月 の増加が見込まれる可能性があるため、Phase 3 着手前に費用試算を再実施する

### 非採用事項（明示的にスコープ外、採用方針により除外）
- **メールドメインによるログイン可否制御**（Google OAuth `hd` パラメータ / GCIP Allowed Domains 機能 / Firebase メールドメインホワイトリスト）
- **Gmail のドット無視・plus addressing の自動同一視**（メール正規化は `.trim().toLowerCase()` のみ適用）
- **SAML/OIDC 連携**（将来対応、本ADRのスコープ外）
- **パスワード認証・匿名認証**（本システムは Google プロバイダのみを許可）

## 参考
- インシデント契機: 2026-04-21 403 org_internal
- Codex セカンドオピニオン（2026-04-21）
- 関連ADR: ADR-005（Firebase Auth）、ADR-006（allowed_emails）、ADR-007（マルチテナント分離）、ADR-030（責務分離）
- Google 公式: [GCIP multi-tenancy](https://cloud.google.com/identity-platform/docs/multi-tenancy)
