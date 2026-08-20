# ADR-041: dry-run UI 両レーン化 AC-α7-09/10/12 の検証方法変更（Playwright → component/統合テスト）

## ステータス

承認済み・実装完了（Issue #584 クローズ）

## コンテキスト

Phase 4 α-7「dry-run UI 両レーン化」（`docs/specs/2026-06-03-phase-4-pr-alpha-7-dry-run-ui-impl-plan.md`）の設計時点（2026-06-03）では、AC-α7-04/05/09/10/11/12/13 の検証方法として Playwright（実ブラウザでの DOM 検証）が指定されていた。

実装後（PR #517/#519）、Session 64 で以下が判明した:

- `AUTH_MODE=dev` では web 側の Firebase Auth SDK 購読処理が `AUTH_MODE==="firebase"` の場合のみ有効化される設計（`web/lib/auth-context.tsx`）であり、`AUTH_MODE=dev` では `user` state が恒久的に `null` のまま更新されない
- `web/app/super/layout.tsx`（`SuperAdminLayout`）は `user===null` の間サインイン画面のみを表示し `children` を一切レンダリングしないため、`/super/dispatch-settings` を含む super 配下のページへブラウザナビゲーションで到達する経路が存在しない
- dev モード用の UI ログインバイパス機構（Firebase User モック注入等）はコード上に存在しない（ADR-005 の「dev 時ヘッダ疑似認証」は API 直叩き専用の設計であり、ブラウザ SPA 側の認証状態を模擬する仕組みは含まない）

この制約により、Session 64 では「戦略 B（ハイブリッド）」として AC-α7-05（API 認可境界の 401/403）のみ Playwright API テスト（`e2e/tests/dispatch-dry-run-api.spec.ts`）でカバーし、AC-α7-09/10/12 を含む DOM 検証系 AC を OQ #17 follow-up として保留していた。この保留分を独立追跡していたのが Issue #584（cutover Step 6 前完了必須、P1）である。

Issue #584 着手にあたり、上記制約の解消（Firebase Auth Emulator 導入 or dev-mode ログインバイパス新設）は認証まわりの新規機構追加を伴う別の新機能・アーキテクチャ判断となり、当初 Issue の見積もりを大きく超える規模になることが判明した。あわせて既存テスト（`DryRunPreview.test.tsx` 27件、`useDryRun.test.tsx` 9件）の精査により、AC-α7-04/11/13 は component test で実質網羅済み、AC-α7-09/12 は部分カバー、AC-α7-10 は未カバーであることが判明した。

## 決定

1. **AC-α7-09/10/12 の検証方法を Playwright から component/統合テストへ正式変更する**。認証まわりの新規機構追加（Firebase Auth Emulator 導入 or dev-mode ログインバイパス新設）は本 Issue のスコープに含めない。
2. **AC-α7-09（a11y）**: `jest-axe` による自動 a11y 違反検出テストを追加。role/aria 属性の個別 assert は既存カバー継続。**実際の Tab キー順序遷移と `:focus-visible` outline の CSS 描画は jsdom の技術的限界により検証不可能**なため、既知の未検証ギャップとして design doc に明記し残存リスクとして許容する。
3. **AC-α7-10（レスポンシブ）**: Tailwind の responsive breakpoint クラス（`md:grid-cols-N`、`overflow-x-auto`）が JSX 出力に含まれることの静的チェックのみ追加。**375px/768px での実際の折り返し・列数変化そのものは jsdom にレイアウトエンジンがないため本質的に検証不可能**であり、同様に既知の未検証ギャップとして許容する。
4. **AC-α7-12（リクエスト制御）**: FE 側は実 `useDryRun` hook + `DryRunPreview` コンポーネントを結合した component test で「連打→dedupe→button disabled」の一気通貫挙動を追加検証。BE 側の limiter/single-flight は既存 integration test（`dispatch-dry-run.test.ts`）で担保済みのため追加なし。
5. **AC-α7-04/05/11/13 は変更なし**。04/11/13 は既存 component test で十分網羅、05 は既存 Playwright API テストで十分網羅と判断する。
6. **残存ギャップ（AC-09 の Tab 順序/focus-visible、AC-10 の実レイアウト検証）は新規 Issue を起票しない**。triage 基準（実バグ/実害/CI 破壊/rating≥7 かつ confidence≥80/ユーザー明示指示）を満たさない既知の限定的リスクであり、design doc 上の明記で足りると判断する。将来 Firebase Auth Emulator 等で `AUTH_MODE=dev` の super UI 到達制約が解消された際に再評価する。

## 理由

- **cost-benefit**: Issue #584 の本来のスコープは「dry-run UI の主要 AC が壊れていないことの自動検証」であり、認証機構の新設は本質的に別のアーキテクチャ判断。cutover Step 6 前の完了必須項目としての緊急性に対し、認証基盤の新設は不釣り合いに大きい。
- **jsdom の技術的限界は回避不能**: `:focus-visible` の CSS 描画判定とレイアウト計算（viewport 幅による折り返し）は、ブラウザのレンダリングエンジンが必要な検証であり、jsdom 環境のコンポーネントテストでは原理的に代替できない。この事実を隠さず明記することが、AC の reward hacking（形だけのテスト追加で「検証済み」を偽装すること）を避ける。
- **既存テスト資産の活用**: AC-04/11/13 は既に十分な component test カバレッジがあり、重複した Playwright テストを追加する価値は薄い（`rules/testing.md` §0: 「E2E は致命的ビジネス導線の最終確認のみ」という本プロジェクトのテスト戦略とも整合する）。

## 影響

- `web/app/super/dispatch-settings/components/__tests__/DryRunPreview.test.tsx`: AC-09 (jest-axe)、AC-10 (静的クラスチェック)、AC-12 (hook 結合連打テスト) を追加
- `web/package.json`: `jest-axe` / `@types/jest-axe` を devDependency に追加
- `docs/specs/2026-06-03-phase-4-pr-alpha-7-dry-run-ui-impl-plan.md`: §5 AC-α7-09/10/12 の検証欄を実態に合わせて改訂
- Issue #584 クローズ。親 Issue #521（postponed、15件アンブレラ）は該当7件のうち本 Issue 分が解消したことをコメントで反映

## 関連

- 元 Issue: #584（親: #521）
- 元 PR: #517（α-7-BE）/ #519（α-7-FE）
- 関連 ADR: ADR-005（Firebase Authentication）
- 設計仕様書: `docs/specs/2026-06-03-phase-4-pr-alpha-7-dry-run-ui-impl-plan.md`
