# Phase 3 follow-up #3 設計仕様書: 自動補完 session の滞在時間表示分離

**作成日**: 2026-06-10
**Issue**: #533 Phase 3 follow-up #3 (現場フィードバック起因)
**前提**: Phase 1 (PR #537) / Phase 2 (PR #539, #541) / Phase 3 (PR #552, #555, #557) 完了後

---

## 1. 背景

### 現場フィードバック
2026-06-10、現場から「合格のみで抽出した PDF」に**滞在時間 1 分の合格行が混入**するとのフィードバック。具体例:

- 受講者「前田さより」さん 2026/05/30 のレッスン 2「Google ドライブの活用」
- 入室 08:41 / 退室 08:42 / 滞在時間 1 分 / テスト合格 100 点 / 「自動補完」バッジ表示
- 行政提出資料として「1 分で合格」は不自然に見える

### 構造的原因
`createSyntheticCompletedSession` (PR #537、`services/api/src/services/lesson-session.ts:449-484`) は `entryAt = quiz.startedAt` / `exitAt = quiz.submittedAt` で session を作成。これは「quiz 解答時間 = 1〜2 分」をそのまま session 滞在時間として記録する。これ自体は**正しい一次データ** (quiz 開始 → 提出の時刻記録) だが、出席レポート UI でこれを通常 session と同じ「滞在時間」カラムで表示すると違和感が出る。

---

## 2. 方針判断経緯

### 当初検討された案 (B 案)
- entryAt を `submittedAt - SESSION_DURATION_MS` (本番 3h) に書き換え、過去 17 件も backfill 再実行で統一
- ユーザー (開発者) も一度承認

### Codex セカンドオピニオン (`feedback_destructive_migration_codex_review.md` 準拠) で **No-Go 判定**
1. **真実性リスク**: `entryAt = submittedAt - 3h` は実打刻でも quiz 開始時刻でもなく、運用上限値からの逆算 = 「3 時間滞在した」と読める値の捏造。「自動補完」バッジは PR #555 で **PDF 非表示**なので、行政提出時に provenance が伝わらない
2. **監査証跡の弱さ**: 旧 entryAt は GitHub Actions artifact (90 日) + ローカルの backup JSON にしか残らず、Firestore からは消える
3. **`SESSION_DURATION_MS` 依存の不安定性**: runtime config を履歴データ改変の根拠に使うと、将来 3h → 4h 変更時に「過去 17 件はどっち？」が説明不能
4. **race condition / 日付フィルタ副作用**: dry-run と execute の間で PATCH 可能 / `entryAt` 3 時間前移動で日付境界をまたぐ集計に副作用
5. **本質**: 「synthetic を通常 session と同じカラムで扱っている」のが問題。一次データ書き換え不要

### 採用案 (A 案)
**UI 表示層のみで対応**。Firestore データは一切変更せず、`isSynthetic=true` の record の滞在時間カラム表示を `"— (テストのみ)"` に変える。

---

## 3. ゴール

- 出席レポート画面 (`/super/attendance`) で `isSynthetic=true` record の滞在時間カラム表示を `"— (テストのみ)"` に変更
- PDF 出力時も同表示 (画面 DOM をそのまま印刷するため自動で同期)
- データ改変ゼロ、過去 17 件 + 今後の自動補完 すべて即時自動適用
- ソート時 synthetic record は末尾配置 (実滞在時間ではないため数値比較対象外)

---

## 4. スコープ

### IN
- `web/app/super/attendance/_helpers/stay-duration.ts` に synthetic 対応関数追加
- `web/app/super/attendance/page.tsx` 滞在時間カラム表示変更
- ソートロジックの synthetic 末尾配置対応
- 単体テスト追加 (新ヘルパー関数)
- ADR-027 改訂履歴に Phase 3 follow-up #3 entry 追記

### OUT
- Firestore データ書き換え (一切なし)
- API レスポンス変更 (なし、`isSynthetic` は既存フィールド)
- shared-types 変更 (なし)
- 他画面の表示変更 (該当画面 = `/super/attendance` のみ)
- backfill script 改修 (B 案で計画したが採用案では不要)
- `createSyntheticCompletedSession` ヘルパー改修 (なし、一次データ生成は現行維持)

---

## 5. 実装詳細

### 5.1 stay-duration.ts ヘルパー拡張

新関数 `formatRecordStayDuration` + `isStayTimeEdited` を追加:

```typescript
/**
 * record 単位の滞在時間表示。isSynthetic=true && entryAt/exitAt 未編集 (original snapshot との差分なし)
 * は実滞在時間ではないため「— (テストのみ)」表示。entryAt/exitAt 編集済は通常計算。
 * editedAt 単独では quizScore のみ編集でも付与されるため使えない (HIGH 指摘反映)。
 */
export function formatRecordStayDuration(record: {
  isSynthetic: boolean;
  entryAt: string | null;
  exitAt: string | null;
  original?: { entryAt: string | null; exitAt: string | null };
}): string {
  if (record.isSynthetic && !isStayTimeEdited(record)) return "— (テストのみ)";
  return formatStayDuration(calculateStayDurationMs(record.entryAt, record.exitAt));
}

export function isStayTimeEdited(record: {
  entryAt: string | null;
  exitAt: string | null;
  original?: { entryAt: string | null; exitAt: string | null };
}): boolean {
  if (!record.original) return false;
  return (
    record.entryAt !== record.original.entryAt ||
    record.exitAt !== record.original.exitAt
  );
}
```

### 5.1.1 編集機能 (#557) との整合性

`PATCH /super/tenants/:tenantId/attendance-report/:sessionId` は `entryAt/exitAt/exitReason/quizScore/quizPassed` を編集可能で、**いずれを編集しても `editedAt` が無条件付与される** (`super-admin.ts:1189`)。`isSynthetic` は不変 (provenance flag)。本関数は **entryAt/exitAt の `original` snapshot との差分** で判定 (`editedAt` 単独判定では quizScore のみ編集ケースで「1 分滞在」が再出現するため使わない、HIGH 指摘反映):

| isSynthetic | entryAt/exitAt 編集 | original | 表示 | 意味 |
|-------------|---------------------|----------|------|------|
| false | - | - | 通常計算 | 通常 session (現状維持) |
| true | なし | undefined | `"— (テストのみ)"` | 過去 17 件 + 今後の自動補完 (本変更の主目的) |
| true | なし | あり + 同値 | `"— (テストのみ)"` | quizScore/quizPassed のみ編集 (HIGH 指摘反映) |
| **true** | **あり** | **あり + 差分** | **通常計算** | **entryAt/exitAt を実時刻に修正 = 管理者確認** |

### 5.2 page.tsx 表示変更

該当箇所 (`page.tsx:613-615`):
```diff
- <TableCell data-col="stayDuration" className="whitespace-nowrap text-sm">
-   {formatStayDuration(calculateStayDurationMs(r.entryAt, r.exitAt))}
- </TableCell>
+ <TableCell data-col="stayDuration" className="whitespace-nowrap text-sm">
+   {formatRecordStayDuration(r)}
+ </TableCell>
```

### 5.3 ソート対応

該当箇所 (`page.tsx:305-313`):
```typescript
if (sortKey === "stayDuration") {
  // isSynthetic=true は実滞在時間ではないため末尾 (null と同等扱い)
  const av = a.isSynthetic ? null : calculateStayDurationMs(a.entryAt, a.exitAt);
  const bv = b.isSynthetic ? null : calculateStayDurationMs(b.entryAt, b.exitAt);
  if (av === null && bv === null) return 0;
  if (av === null) return 1;
  if (bv === null) return -1;
  return (av - bv) * dir;
}
```

### 5.4 PDF 出力

PR #554 で導入された `applyPdfColumnHide` (`_helpers/pdf-print.ts`) は data-col 単位の表示/非表示制御。本変更は滞在時間セルの**中身の文字列のみ変更**するため PDF 出力ロジックに変更不要 (画面表示 = `"— (テストのみ)"` がそのまま PDF にも印字される)。

---

## 6. Acceptance Criteria

| # | 基準 | 検証方法 |
|---|------|---------|
| AC1 | `isSynthetic=true` record の滞在時間カラムが `"— (テストのみ)"` 表示 | unit test + Playwright MCP |
| AC2 | `isSynthetic=false` record は従来通り `formatStayDuration` 結果表示 | unit test |
| AC3 | 滞在時間カラムでソート時、synthetic record は末尾配置 (昇順/降順とも) | unit test + Playwright MCP |
| AC4 | PDF 出力時も `"— (テストのみ)"` がそのまま印字 (バッジは非表示維持) | Playwright MCP (print emulate) |
| AC5 | Firestore データ変更ゼロ (本番含め一切書き込まない) | grep / コードレビュー |
| AC6 | 過去 17 件 + 今後の自動補完すべてに自動適用 (条件分岐なし) | Playwright MCP 本番確認 |
| AC7 | `formatRecordStayDuration` 関数の境界値テスト (isSynthetic=true/false × entryAt/exitAt null/非 null の組み合わせ) | unit test |
| AC8 | 編集済 synthetic (isSynthetic=true + editedAt あり) は通常計算で表示される (Evaluator 指摘反映) | unit test |
| AC9 | 編集済 synthetic はソート時も末尾配置から外れ、通常 session と同じ順序で並ぶ | page.tsx ロジックレビュー + Playwright MCP |

---

## 7. リスクと緩和

| リスク | 緩和策 |
|--------|--------|
| 表示変更だけで現場の問題が解消しない | A 案不採用時に C 案 (PDF 別セクション分離) に escalate 可能、ADR-027 に判断経緯記録 |
| ソート時 synthetic 末尾が現場の意図と異なる | Playwright MCP で本番確認、現場から再フィードバックあれば挙動変更 |
| `"— (テストのみ)"` の文言が長すぎてカラム幅破壊 | whitespace-nowrap で 1 行強制、必要なら CSS truncate |

---

## 8. ADR-027 改訂履歴 entry (案)

```
- **2026-06-10 (Phase 3 follow-up #3, #533)**: **動機**: 行政提出 PDF で「合格のみ」抽出した際、自動補完 session の滞在時間 1 分が不自然に見えるとの現場フィードバック。**当初検討した entryAt 書き換え案 (B 案: entryAt = submittedAt - SESSION_DURATION_MS)** は Codex セカンドオピニオンで No-Go 判定 (行政提出データの真実性リスク / 監査証跡の弱さ / `SESSION_DURATION_MS` 依存の不安定性 / 日付フィルタ副作用)。**採用案 (A 案)**: UI 表示層のみで対応、Firestore データは維持し、出席レポートの滞在時間カラムを `isSynthetic=true` 時に `"— (テストのみ)"` 表示。データ改変ゼロ + 過去 17 件含め即時自動適用。
```

---

## 9. 関連ドキュメント

- ADR-027: `docs/adr/ADR-027-lesson-session-attendance.md`
- Phase 3 設計仕様書 (#551): `docs/specs/2026-06-09-phase3-synthetic-session-badge-design.md`
- Codex セカンドオピニオン thread: 019eaf6b-6b25-7011-be78-aaaa02ced8d2
- 前 session handoff: `docs/handoff/LATEST.md` (Session 72)
