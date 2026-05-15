# ADR-035: shared-types パッケージの runtime export 責務境界

- Status: **Accepted**
- Date: 2026-05-15
- Deciders: system-279, sanwaminamihonda@gmail.com
- 関連: ADR-018 (FE-BE 共有 DTO の前身議論), PR #368 (Issue #366 fix で初の runtime helper を追加), Session 23 末ハンドオフ「優先度6」

## Context

`@lms-279/shared-types` パッケージは当初「FE-BE 間で共有する **API レスポンス DTO 型のみ**」を提供する目的で導入された (プロジェクト CLAUDE.md「重要な設計判断」末尾参照)。`src/index.ts` の export も `export type *` のみで構成されており、tsc は `.d.ts` を主たる成果物として扱う前提だった。

2026-05-14 の Issue #366 fix (PR #368) で、**初の runtime helper** として `buildProgressPdfFilename` を `src/filename.ts` に追加し、`index.ts` に `export * from "./filename.js"` (type ではない値 export) を加えた。これは以下の理由で本パッケージに置く判断となった:

1. FE (ブラウザダウンロード経路) と BE (Gmail draft 添付経路 / HTTP attachment 経路) の両方で**同一の sanitize ロジックを使う必要**があった
2. ロジックの不一致は Issue #366 の再発 (日本語名が `___` に置換される等) を直接引き起こす
3. 関数本体が純粋関数 (副作用なし / 依存なし / 30 行未満) で、両環境で安全に動く

Codex review (PR #368) はこの追加を「許容範囲」と評価したが、**「shared-types は型のみ」という暗黙ルールを明示的に破る初の事例** であり、責務境界が明文化されていないと将来 import 経路の肥大化や FE バンドルサイズ増加を招く懸念が残った。本 ADR で受け入れ条件と除外条件を明文化する。

## Decision

### 1. shared-types の責務 (拡張)

shared-types は以下の 2 種を提供する:

- **(A) 型定義**: FE-BE 間で形が一致する必要がある DTO / Enum / Interface (`export type *`)
- **(B) 純粋ロジック helper**: FE と BE の両方で**同一実装が必要**な、副作用なし・依存なしの純粋関数 (`export *`)

### 2. runtime helper の追加許可条件 (全て満たす必要)

| # | 条件 | 検証方法 |
|---|---|---|
| C1 | **FE / BE 両方から呼ばれる**ことが既に確定している (将来のため、ではなく既存呼出箇所が 2 つ以上ある) | `grep` で import 元を 2 箇所以上確認 |
| C2 | **副作用なし**: DOM / Node API / fetch / fs / Firestore / GCS / Buffer 等への依存ゼロ | 関数本体 + 同一ファイル内の依存を目視確認 |
| C3 | **外部依存なし**: `dependencies` / `peerDependencies` を増やさない (TypeScript / Node 標準型のみ) | `packages/shared-types/package.json` の差分を確認 |
| C4 | **小さい**: 1 ファイル / 1 export / 概ね 100 行以内 | 行数カウント |
| C5 | **ロジック分岐が一致しなければ即バグになる** ことを ADR / Issue / PR で示せる | 関連 Issue 番号で証明 |

### 3. 除外: shared-types に置かない物

- **HTTP クライアント**: `fetch` ラッパ等は FE 側 `web/lib/api/` または BE 側 SDK に置く
- **環境固有ロジック**: `process.env` / `document` / `window` 等の参照を含む helper
- **ビジネスロジック**: 採点 / 進捗集計 / 権限判定など、サーバー権威であるべき処理
- **大規模 helper**: 100 行を超える / 複数 export がある / テストが重い物
- **ライブラリ依存 helper**: date-fns, zod 等の peerDependency を要求する物

これらは原則として **api 側 (`services/api/src/...`)** または **web 側 (`web/lib/...`)** に置き、重複が問題化したら別パッケージ抽出 or shared-types への昇格を都度 ADR で判断する。

### 4. ディレクトリ規約

- 型定義: `src/<domain>.ts` (例: `quiz.ts`, `progress-pdf.ts`) — `export type *` で index 経由
- runtime helper: `src/<topic>.ts` (例: `filename.ts`) — `export *` で index 経由
- 同一ファイル内に型と runtime helper を混在させる場合は、ファイル冒頭の docstring で意図を明示する

### 5. import 経路の維持

FE / BE 双方とも `import { ... } from "@lms-279/shared-types"` で利用する。サブパス import (`@lms-279/shared-types/filename`) は **採用しない** (現状 `exports` フィールドが `.` のみで、サブパス追加は将来別 ADR で検討)。

### 6. 検証フロー (新規 runtime helper 追加時)

1. impl-plan 段階で C1〜C5 を**全てチェック**し、PR description に列挙する
2. PR レビュー時に Codex review (`/codex review`) を必須 (型のみ追加では任意)
3. 追加後の `packages/shared-types/dist/` 出力に `.js` が増えていることを確認 (型のみ export なら `.js` は空に近い)

## Consequences

### 良い影響

- shared-types の責務が明示化され、将来「shared-utils 化」して肥大化するリスクを構造的に抑止
- FE バンドルサイズへの影響を予測可能に保てる (C2, C3 により node_modules を芋づる式に取り込まない)
- Codex / レビュアが「shared-types に置いて良いか」を機械的にチェック可能

### 受容するトレードオフ

- runtime helper が必要な度に C1〜C5 を確認するレビューコストが発生する
- FE / BE 片側のみで使う helper を将来 shared-types に「先回り」で置く設計は禁止される (YAGNI 厳守)

### 既存実装への影響

- `src/filename.ts` (`buildProgressPdfFilename`) は本 ADR の許可条件を遡及確認 → C1〜C5 全て満たす (FE: `web/lib/` 経由のダウンロード、BE: `gmail-draft.ts` / `progress-pdf.ts` の 2 箇所で使用、副作用なし、依存なし、64 行、Issue #366 が C5 の根拠)
- 現状他に runtime export はなく、追加修正は不要

## 不採用案

### Alt-1: 別パッケージ `@lms-279/shared-utils` 切り出し

純粋 helper 専用パッケージを切る案。今回 1 ファイル / 1 export しかない状況で先に器を作るのは YAGNI のため見送り。将来 runtime helper が 3 ファイル以上になった時点で再評価する。

### Alt-2: helper を FE / BE で個別実装し型のみ共有

実装重複により Issue #366 の再発リスクが残る。C5 (ロジック分岐が一致しなければ即バグ) を満たすケースでは積極的に却下する。

## Open Questions / 将来の再評価トリガ

- runtime helper が 3 ファイル以上に増えた → Alt-1 (別パッケージ化) 再評価
- ライブラリ依存 helper が必要になった (例: date-fns ラッパを共有したい) → exports サブパス + peerDependencies 設計を別 ADR で
- FE バンドルサイズに有意な増加が観測された (基準: web の production build で +10 KB) → ESM tree-shaking 設定見直し
