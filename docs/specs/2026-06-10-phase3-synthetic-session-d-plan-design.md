# Phase 3 follow-up #4 設計仕様書: D 案 — 動画長 + テスト時間の換算退室時刻

**作成日**: 2026-06-10
**Issue**: #533 Phase 3 follow-up #4 (PR #559 撤回 + D 案採用)
**前提**: Phase 1 (#537) / Phase 2 (#539, #541) / Phase 3 (#552, #555, #557) 完了後、PR #559 (A 案 UI 表示分離) を撤回し業務的に正しいデータ記録に転換

---

## 1. 背景

### PR #559 (A 案) の状況
PR #559 で「自動補完 session の滞在時間カラムを `"— (テストのみ)"` 表示に分離」する A 案を実装、本番 deploy + Playwright MCP 確認完了。しかし、開発者から **「Firestore データ自体を業務的に正しい値に修復したい」** との要望を受け、方針転換。

### 業務ロジック再整理
ADR-019 動画完了ゲート (`checkVideoCompletionGate`、`services/api/src/routes/shared/quiz-attempts.ts`) により、`quiz.requireVideoCompletion=true` の場合:
- テスト受験には `video_analytics.isComplete=true` が必須
- = **過去に動画視聴完了していないと quiz 受験不可** (403 reject)
- 一度 isComplete になれば、その後何度でも quiz 受験可能 (動画再生スキップ可)

**自動補完 session の対象は必ず過去に動画視聴完了済** (= 「動画 + テスト」のフル業務フローを既に経ている)。よって滞在時間に「動画長 + テスト時間」を含めるのが業務的に正しい。

---

## 2. 方針判断経緯

### A〜E 案検討 + Codex 2 ラウンドの No-Go 判定

| 案 | 内容 | 結果 |
|----|------|------|
| A | UI 表示分離 `"— (テストのみ)"` | PR #559 merged → 本セッションで撤回 |
| **B** | **`entryAt = submittedAt - SESSION_DURATION_MS (3h)`** | **Codex No-Go** (真実性リスク等) |
| C | PDF 出力時に synthetic セクション分離 | 検討、Phase 3 で却下 |
| **D** | **`exitAt = startedAt + video.durationSec*1000 + quizDurationMs` (本採用)** | Codex 3 ラウンド目で条件付き Go |
| E | 自動補完を作らない | Issue #533 根本目的を否定、却下 |

### D 案が B 案と異なる根拠 (Codex 3 ラウンド目で確認済)

| 観点 | B 案 (No-Go) | D 案 (採用) |
|------|------------|------------|
| 算出根拠 | `SESSION_DURATION_MS` (env、runtime config、任意の運用上限値) | `video.durationSec` (lesson 固有の客観値、要件定義の一部) |
| 算出値の意味 | 「3 時間滞在した」と読める捏造に近い | 「動画見てテスト受験して合格した」業務フローの忠実な時間表現 |
| 真実性 | 任意値からの逆算 = 行政提出時に説明不能 | 業務的根拠あり = 行政提出時に説明可能 |
| env 変更影響 | 3h → 4h 変更で過去データ解釈が揺れる | 動画 (lesson 固有) は不変、影響なし |
| 日付フィルタ副作用 | `entryAt` を 3h 前にずらす = 日付境界またぎ多発 | `entryAt` 維持 = 副作用なし |

### D 案の残るリスク (Codex 3 ラウンド目指摘、文書化で対応)
- **「実打刻ではなく換算値である」ことの説明不足リスク** → ADR-027 / 仕様書 / 画面 tooltip で **「換算退室時刻」「出席時間として動画長を合算する処理」** と明記して緩和

---

## 3. ゴール

- 自動補完 session の滞在時間に「動画長 + テスト時間」を反映 (業務フローの真実な時間記録)
- 過去 17 件 (長遊園 12 + 福の種 5) も backfill で `exitAt` 一括上書き
- PR #559 (UI 表示分離) を撤回し、`formatStayDuration` 直接利用で通常滞在時間表示に復帰
- `original` snapshot (#557) / 「自動補完」バッジ (#552) / 「編集済」バッジ (#557) / `buildEditPatchBody` (dirty 判定) は維持

---

## 4. スコープ

### IN

- `createSyntheticCompletedSession` (`services/api/src/services/lesson-session.ts:449`) で `exitAt` 算出を変更
- 呼び出し元 (`services/api/src/routes/shared/quiz-attempts.ts:434`) で `video.durationSec` を渡す
- `scripts/backfill-synthetic-sessions.ts` に `update-existing` モード追加 (過去 17 件の exitAt 一括上書き)
- PR #559 の UI 表示分離コード削除:
  - `web/app/super/attendance/_helpers/stay-duration.ts`: `formatRecordStayDuration` / `SYNTHETIC_STAY_DURATION_LABEL` / `stayDurationSortValue` 削除
  - `web/app/super/attendance/page.tsx`: `formatStayDuration` 直接利用に復帰
  - 関連 unit test 削除 / 修正
- `formatTime` 改修 (JST 日付違い tooltip + 翌日表示、防御的)
- `video.durationSec` hard guard (`Number.isFinite && > 0`) 共通化
- 単体テスト全 AC 20 件カバー
- ADR-027 改訂履歴に follow-up #4 entry 追加 (換算退室時刻明記)
- 本仕様書追加

### OUT (= 維持)

- `buildEditPatchBody` / `dateTimeJSTtoISO` / `isStayTimeEdited` (PR #559 由来、no-op 更新で編集済化を防ぐ独立改善)
- 「自動補完」バッジ (#552) / 「編集済」バッジ (#557)
- `original` snapshot / `editedAt` 機能 (#557)
- `entryAt` 値 (`quiz.startedAt` 維持)
- `quiz.submittedAt` (`quiz_attempts` doc 内、現状維持)

---

## 5. 実装詳細

### 5.1 createSyntheticCompletedSession 改修

```typescript
// services/api/src/services/lesson-session.ts:449
export async function createSyntheticCompletedSession(
  ds: DataSource,
  params: {
    userId: string;
    lessonId: string;
    courseId: string;
    videoId: string;
    quizAttemptId: string;
    startedAt: string;
    submittedAt: string;
    videoDurationSec: number; // ← 新規追加
  }
): Promise<{ session: LessonSession; created: boolean }> {
  // video.durationSec hard guard (Codex 指摘 #2 反映)
  if (!Number.isFinite(params.videoDurationSec) || params.videoDurationSec <= 0) {
    throw new Error(
      `createSyntheticCompletedSession: invalid videoDurationSec=${params.videoDurationSec} for lesson ${params.lessonId}`
    );
  }

  const id = `synthetic_${params.quizAttemptId}`;
  const startedMs = new Date(params.startedAt).getTime();
  const submittedMs = new Date(params.submittedAt).getTime();
  const quizDurationMs = submittedMs - startedMs;
  const videoDurationMs = params.videoDurationSec * 1000;
  // D 案: 業務的「動画見てテスト受験して合格」の換算退室時刻
  const exitAt = new Date(startedMs + videoDurationMs + quizDurationMs).toISOString();
  const deadlineAt = new Date(startedMs + SESSION_DURATION_MS).toISOString();

  return ds.createLessonSessionWithId(id, {
    userId: params.userId,
    lessonId: params.lessonId,
    courseId: params.courseId,
    videoId: params.videoId,
    sessionToken: `synthetic-${params.quizAttemptId}`,
    status: "completed",
    entryAt: params.startedAt, // 維持 (実刻)
    exitAt, // D 案: 換算退室時刻
    exitReason: "quiz_submitted",
    deadlineAt,
    pauseStartedAt: null,
    longestPauseSec: 0,
    sessionVideoCompleted: true,
    quizAttemptId: params.quizAttemptId,
    isSynthetic: true,
  });
}
```

### 5.2 呼び出し元 (quiz-attempts.ts:434) 更新

```typescript
// 既に video を取得済 (line 422-433)
if (!video) { /* skip */ } else {
  const { created } = await createSyntheticCompletedSession(ds, {
    userId,
    lessonId: quiz.lessonId,
    courseId: quiz.courseId,
    videoId: video.id,
    quizAttemptId: updated.id,
    startedAt: attempt.startedAt,
    submittedAt: updated.submittedAt,
    videoDurationSec: video.durationSec, // ← 新規追加
  });
}
```

### 5.3 backfill script update-existing モード

```typescript
// scripts/backfill-synthetic-sessions.ts に追加
export type BackfillMode = "create-missing" | "update-existing";

// 既存ロジック (categorizeAttempt) を拡張、新カテゴリ "update_existing" 追加
export function categorizeAttemptForUpdate(
  attempt: AttemptInfo,
  relatedSessions: SessionInfo[]
): "update_target" | "audit_only" | "skip" {
  // synthetic doc が存在し、かつ「旧形式」(現 exitAt === quiz.submittedAt) のみ更新対象
  const synthetic = relatedSessions.find(
    (s) => s.id === `synthetic_${attempt.id}` && s.isSynthetic === true
  );
  if (!synthetic) return "skip";

  // 編集済 doc は skip (Codex 指摘 #5: original と editedAt 両方判定)
  if (synthetic.original !== undefined) return "audit_only";
  if (synthetic.editedAt !== undefined) return "audit_only";

  // 旧形式 (exitAt === quiz.submittedAt) のみ対象 (transaction 内でも再検証)
  if (synthetic.exitAt !== attempt.submittedAt) return "audit_only";
  if (synthetic.entryAt !== attempt.startedAt) return "audit_only";

  return "update_target";
}

// 既存 sessionVideoCompleted 設計 + 新 exitAt 算出
export function buildUpdatePayload(
  attempt: AttemptInfo,
  videoDurationSec: number
): { exitAt: string } {
  if (!Number.isFinite(videoDurationSec) || videoDurationSec <= 0) {
    throw new Error(`invalid videoDurationSec=${videoDurationSec}`);
  }
  const startedMs = new Date(attempt.startedAt!).getTime();
  const submittedMs = new Date(attempt.submittedAt!).getTime();
  const quizDurationMs = submittedMs - startedMs;
  return {
    exitAt: new Date(startedMs + videoDurationSec * 1000 + quizDurationMs).toISOString(),
  };
}

// applyBackfillUpdate (新規) で transaction 内再検証 + tenant 別 expected-count + rollback restore mode
```

### 5.4 CLI 引数追加

```bash
# 新規 mode フラグ
--mode=create-missing    # 既存 (Phase 2)
--mode=update-existing   # 新規 (D 案、本仕様)

# tenant 別 expected count (Codex 指摘 #4)
--expected-count-tenant=8vexhzpc:12,fukunotane:5
```

### 5.5 PR #559 UI 表示分離撤回

| 削除対象 | 復帰先 |
|---------|--------|
| `SYNTHETIC_STAY_DURATION_LABEL` 定数 | (削除) |
| `formatRecordStayDuration` 関数 | `formatStayDuration(calculateStayDurationMs(...))` 直接利用 |
| `stayDurationSortValue` 関数 | 旧ロジック (`calculateStayDurationMs` で比較) に復帰 |
| 関連 unit test (synthetic 専用ケース) | 削除 / D 案テストに置換 |

維持対象:
- `isStayTimeEdited` (将来利用余地)
- `buildEditPatchBody` / `dateTimeJSTtoISO` (no-op 更新で編集済化を防ぐ独立改善)

### 5.6 formatTime 日跨ぎ tooltip 改修

```typescript
// web/app/super/attendance/page.tsx (formatTime 改修)
function formatTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("sv", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// 新規: 日跨ぎ時に「翌日 HH:mm」表示 (entryAt と比較)
function formatTimeWithDayDiff(iso: string | null, baseEntryAt: string | null): string {
  if (!iso) return "—";
  const time = formatTime(iso);
  if (!baseEntryAt) return time;
  const baseDate = isoToDateJST(baseEntryAt);
  const targetDate = isoToDateJST(iso);
  if (baseDate === targetDate) return time;
  return `翌 ${time}`; // 簡潔表記
}
```

### 5.7 換算退室時刻の説明文 (UI tooltip)

「自動補完」バッジの title 属性に説明追加:

```tsx
<Badge
  title="このセッションは合格提出から自動補完されました。滞在時間は『動画長 + テスト時間』の換算値です (実際の退室時刻ではありません)。"
>
  自動補完
</Badge>
```

---

## 6. Acceptance Criteria

| # | 基準 | 検証方法 |
|---|------|---------|
| AC1 | 新規 synthetic で `entryAt = quiz.startedAt` (現状維持) | integration test |
| AC2 | 新規 synthetic で `exitAt = startedAt + video.durationSec*1000 + (submittedAt - startedAt)` | integration test |
| AC3 | 滞在時間カラム表示 = 通常の `formatStayDuration` 結果 (動画 60 分 + テスト 1 分 → "1時間1分") | unit test + Playwright MCP |
| AC4 | 「自動補完」バッジは継続表示 (画面のみ、PDF 非表示) | Playwright MCP |
| AC5 | PDF 出力時もバッジ非表示 + 滞在時間正常表示 | Playwright MCP (print emulate) |
| AC6 | backfill update-existing で過去 17 件の exitAt 上書き、entryAt 維持 | script unit test + dry-run |
| AC7 | backfill 実行後の readback で exitAt 新値、entryAt 旧値維持 | script integration test |
| AC8 | PR #559 の `formatRecordStayDuration` / `SYNTHETIC_STAY_DURATION_LABEL` / `stayDurationSortValue` が削除 | grep / 型エラーゼロ |
| AC9 | `buildEditPatchBody` / `isStayTimeEdited` / `dateTimeJSTtoISO` は維持 | grep / テスト維持 |
| AC10 | video 削除済 lesson では synthetic 作成スキップ (現状仕様維持) | integration test |
| AC11 | 日付境界またぎケース (動画 24h 想定) で entryAt < exitAt 整合性維持 | unit test (極端ケース) |
| AC12 | `quizSubmittedAt < exitAt` を許容、API レスポンスで `quizSubmittedAt` 保持 | integration test |
| AC13 | `durationSec ≤ 0 / null / NaN` で synthetic 作成・backfill 更新スキップ + 構造化ログ | unit test + integration test |
| AC14 | 日付境界またぎで表示・PDF・ソート・日付フィルタが期待通り (`formatTimeWithDayDiff` 翌日表示) | unit test + Playwright MCP |
| AC15 | backfill は `editedAt` または `original` 付き doc を更新しない | script unit test |
| AC16 | backfill は 旧 `exitAt = quiz.submittedAt` でない doc を更新しない (transaction 内再検証) | script unit test |
| AC17 | backup に旧 exitAt + 完全 doc snapshot + quiz attempt 原データを含む | script unit test |
| AC18 | tenant 別 expected count 検証 (長遊園 12 / 福の種 5) | script integration test |
| AC19 | dry-run + execute 両方を GitHub Actions artifact に 90 日保管 | workflow YAML |
| AC20 | ADR-027 + 本仕様書 + UI tooltip に「換算退室時刻」を明記 | grep |

---

## 7. リスクと緩和

| リスク | 緩和策 |
|--------|--------|
| 換算値であることが現場・行政に伝わらない | ADR-027 + 仕様書 + 「自動補完」バッジ tooltip + 現場連絡で「換算」を統一明示 |
| `video.durationSec` が極端値 (例: 数時間、Drive 動画長解析失敗) | `Number.isFinite && > 0` ガード + 24h 超で warn ログ |
| backfill 中の concurrent PATCH (現場が編集機能で同時操作) | transaction 内で `original/editedAt なし + 旧 exitAt === quiz.submittedAt + entryAt === quiz.startedAt` 再検証 → skip 件数報告 |
| backup JSON 紛失時の rollback 不能 | GitHub Actions artifact 90 日 + ローカル backup + rollback restore mode 実装 |
| 「テスト後に動画」順序問題 | 「実順序の再現ではなく出席時間の換算」と ADR で明記、画面 tooltip でも補足 |

---

## 8. ADR-027 改訂履歴 entry (案)

```
- **2026-06-10 (Phase 3 follow-up #4, #533)**: **動機**: PR #559 (A 案 UI 表示分離 `"— (テストのみ)"`) は表示層で問題を回避したが、開発者から「Firestore データそのものを業務的に正しい値で記録したい」要望。業務ロジック整理 (ADR-019 動画完了ゲートにより自動補完対象は必ず過去に動画視聴完了済) を踏まえ、**滞在時間 = 動画長 + テスト時間** とする D 案に転換。

  **変更内容**: `createSyntheticCompletedSession` で `exitAt = startedAt + video.durationSec*1000 + quizDurationMs` (entryAt は維持)。過去 17 件 (長遊園 12 + 福の種 5) も backfill update-existing モードで一括上書き。PR #559 の UI 表示分離コード (formatRecordStayDuration / SYNTHETIC_STAY_DURATION_LABEL / stayDurationSortValue) は削除し formatStayDuration 直接利用に復帰。

  **D 案が B 案 No-Go 判定 (前 follow-up 経緯) を回避できる根拠**: `video.durationSec` は **lesson 固有の客観値** (要件定義の一部) であり、B 案の `SESSION_DURATION_MS` (runtime config = 任意の運用上限値) と異なる。「動画見てテスト受験して合格」業務フローの忠実な時間表現で、行政提出時に説明可能。

  **残るリスクと緩和**: `exitAt` が `quiz.submittedAt` から乖離し「テスト後に動画」順序に読まれる余地 → ADR + 仕様書 + UI tooltip で「**換算退室時刻 (出席時間として動画長を合算する処理)**」と明記 (Codex セカンドオピニオン指摘反映)。

  **設計仕様書**: `docs/specs/2026-06-10-phase3-synthetic-session-d-plan-design.md`

  **テスト**: AC 20 件カバー、integration / unit / script / Playwright MCP の 4 層検証。
```

---

## 9. 関連ドキュメント

- ADR-019 (動画完了ゲート): D 案の業務的根拠
- ADR-027 (出席管理): 本改訂対象
- PR #559 (撤回対象): UI 表示分離 A 案
- Codex セカンドオピニオン threads: `019eaf6b-...` (B 案 No-Go) / `019eaf8c-...` (PR #559 review) / `019eafc7-...` (D 案レビュー)
- 前セッション handoff: `docs/handoff/archive/2026-06-10-session-72.md` / Session 73 = `docs/handoff/archive/2026-06-10-session-73.md` (本セッション開始時点でアーカイブ済)
