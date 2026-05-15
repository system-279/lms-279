# @lms-279/shared-types

FE (`web/`) と BE (`services/api/`, `services/notification/`) の間で共有する型・純粋ロジックを提供するパッケージ。

## 責務

| カテゴリ | 例 | export 方式 |
|---|---|---|
| **(A) 型定義** | API レスポンス DTO / Enum / Interface | `export type *` |
| **(B) 純粋ロジック helper** | FE / BE 両方で同一ロジックが必要な純粋関数 | `export *` |

詳細な責務境界・追加条件は [ADR-035: shared-types パッケージの runtime export 責務境界](../../docs/adr/ADR-035-shared-types-runtime-export-boundary.md) を参照。

## 利用方法

```ts
import type { CourseProgressDto, QuizAttemptDto } from "@lms-279/shared-types";
import { buildProgressPdfFilename } from "@lms-279/shared-types";
```

サブパス import (`@lms-279/shared-types/filename` 等) は採用しない。

## runtime helper を追加する前のチェックリスト

ADR-035 の許可条件 C1〜C5 を**全て**満たす必要がある:

- **C1** FE / BE 両方から呼ばれることが既に確定している (既存 import 元 ≥ 2 箇所)
- **C2** 副作用なし (DOM / Node API / fetch / fs / Firestore / GCS / Buffer 依存ゼロ)
- **C3** 外部依存なし (dependencies / peerDependencies を増やさない)
- **C4** 小さい (1 ファイル / 1 export / 概ね 100 行以内)
- **C5** ロジック分岐が一致しなければ即バグ になることを Issue / PR で示せる

満たさない場合は `services/api/src/...` または `web/lib/...` 側に置く。

## 開発

```bash
npm run build -w @lms-279/shared-types     # tsc で dist 生成
npm run type-check -w @lms-279/shared-types
```

依存サービスは `dist/` を参照する。型のみ変更でも `build` を回して `.d.ts` を更新すること (workspace の `"types"` が `dist/index.d.ts` を指している)。

## ファイル構成

```
src/
├─ index.ts              # 集約 export
├─ enums.ts              # Enum 定義
├─ common.ts             # 共通ユーティリティ型
├─ analytics.ts          # 視聴分析 DTO
├─ attendance.ts         # 出席 DTO
├─ sessions.ts           # lesson_sessions DTO
├─ student-progress.ts   # 受講者進捗 DTO
├─ enrollment.ts         # enrollment DTO
├─ quiz.ts               # quiz / quiz_attempts DTO
├─ tenant.ts             # tenant DTO
├─ progress-pdf.ts       # 進捗 PDF レスポンス DTO
└─ filename.ts           # runtime helper: buildProgressPdfFilename (PR #368)
```
