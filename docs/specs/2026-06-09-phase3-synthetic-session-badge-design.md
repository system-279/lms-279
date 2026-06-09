# Phase 3 設計仕様書: 合成 session (isSynthetic) の出席レポート可視化

**作成日**: 2026-06-09
**Issue**: #533 Phase 3
**前提**: Phase 1 (#537, PR merged) / Phase 2 (#539, PR draft) 完了後の運用補助
**実装着手条件**: Phase 2 本番 apply 完了 + 「最低限完了」状態到達後

---

## 1. 背景

### Phase 1〜2 の構造
- **Phase 1 (PR #537)**: `activeSession=null` 時の合格提出で `createSyntheticCompletedSession` ヘルパーが自動補完 (新規発生予防)
- **Phase 2 (PR #539)**: 過去発生分 4 件を `synthetic_{attemptId}` doc id で遡及補正 (整合性回復)
- **Phase 3 (本仕様)**: 合成 session を出席レポート UI で識別可能にする (運用補助)

### Phase 3 の存在意義 (= 完全解消には必須でない理由)
- 合成 session の `entryAt` / `exitAt` は quiz 提出時間と一致するため、出席時間として意味は通じる
- 退室理由は `quiz_submitted` で実 session と同じ → 既存 UI でも差別化不要
- ただし**監査性**と**運用補助** (補正済データの後追い特定) の観点で可視化は価値あり

### 「完了」定義における位置付け
- **最低限完了** (Phase 2 完了時): Phase 3 不要
- **プロジェクト完了** (Phase 3 含む): 可視化 + 監査ログ整備

---

## 2. ゴール

スーパー管理画面「出席・テスト結果レポート」(`/super/attendance`) で、`isSynthetic=true` の session を視覚的に識別できるようにする。

### 成功基準
1. 出席レポートで synthetic session に「自動補完」バッジが表示される
2. バッジにツールチップで「このセッションは合格提出から自動補完されました (#533 Phase 1/2)」と説明
3. 「session 種別」フィルタで「すべて / 自動補完のみ / 実 session のみ」を切り替え可能
4. PDF 出力 (`window.print()`) でもバッジが印字される
5. Playwright E2E で表示・フィルタ・PDF 印字を検証

### スコープ外 (本 Phase 3 では扱わない)
- **CSV エクスポート**: 現行 super attendance は CSV 機能未実装 (PDF のみ)。将来 CSV 機能が追加される際に `is_synthetic` 列を含める設計とし、本 PR では対応しない (codex 指摘で訂正)
- **admin 側出席画面** (`/admin/analytics/attendance/courses/:courseId`): 別系統 API (`AdminAttendanceRecord`)。本 Phase 3 は super 側に限定、admin 側は非ゴール
- **検索・分析・テナント設定**: サーバ側 `isSynthetic` query を行わない限り Firestore index 不要

---

## 3. 影響範囲 (4 レイヤー)

| レイヤー | ファイル | 変更内容 |
|---------|---------|---------|
| 共有型 | `packages/shared-types/src/attendance.ts` | `SuperAttendanceRecord` に `isSynthetic: boolean` 追加 |
| API | `services/api/src/routes/super-admin.ts:1040-1059` | response record builder で `isSynthetic: data.isSynthetic === true` を追加 |
| FE 表示 | `web/app/super/attendance/page.tsx` | バッジコンポーネント追加、新規「session 種別」フィルタ追加 (既存「退室理由フィルタ」とは独立) |
| E2E | `e2e/super-attendance.spec.ts` (新規 or 拡張) | synthetic session 表示 / フィルタ / PDF 印字 検証 |

---

## 4. データフロー

```
[Firestore: lesson_sessions]
  └─ doc.isSynthetic (boolean | undefined)
       │
       ▼
[API: super-admin.ts /attendance-report]
  └─ record.isSynthetic: data.isSynthetic === true
       │
       ▼ (JSON response)
       │
[Shared-types: SuperAttendanceRecord]
  └─ isSynthetic: boolean
       │
       ▼
[FE: super/attendance/page.tsx]
  ├─ COLUMNS: entryAt カラムに <SyntheticBadge> 表示条件 (改行なし、印刷時も保持)
  ├─ 新規 syntheticFilter state: "all" | "synthetic_only" | "actual_only"
  │  (既存 exitReasonOptions / 退室理由フィルタは変更しない)
  ├─ filterMatcher: matchesIsSyntheticFilter(record, filter) — 純粋関数
  └─ PDF (window.print()): entryAt カラム内バッジが印字対象
     (amber-tone は印刷時に薄い灰色になる可能性、border + text で識別性確保)
```

### 重要設計判断
- **API layer で `=== true` 比較**: Firestore の `isSynthetic` フィールドは undefined / null / false / true の可能性 (Phase 1 投入前の既存 doc は欠落)。明示的に `=== true` で boolean 正規化
- **FE では boolean 必須**: optional にせず `false` を明示。条件分岐の防御的コードを減らす

---

## 5. UI 仕様

### 5.1 バッジ表示

| 場所 | デザイン | テキスト |
|------|---------|---------|
| `entryAt` セルの右側 (改行なし、間隔 4px) | 既存「未退出」バッジ (#532) と同じ tailwind 構造 | 「自動補完」 |

```tsx
{r.isSynthetic && (
  <Badge
    variant="outline"
    className="ml-1 border-amber-400 bg-amber-50 text-amber-700"
    title="このセッションは合格提出から自動補完されました (#533 Phase 1/2)"
  >
    自動補完
  </Badge>
)}
```

### 5.2 フィルタ拡張

既存「退室理由フィルタ」とは別に **新規「session 種別」フィルタ** を追加 (RadioGroup / segmented 推奨、Codex 反映):
- `all` (デフォルト): すべて
- `synthetic_only`: 自動補完のみ
- `actual_only`: 実 session のみ

### 5.3 PDF 印字 (現行 `window.print()` のみ、CSV 未実装)

- entryAt カラム内のバッジは印刷対象に含める
- 印刷時 amber-tone (背景色) はブラウザの「背景を印刷」設定次第で出ない可能性あり
- 対策: `border` + `text-color` で背景なしでも識別できるよう CSS 設計

### 5.4 ソート

`isSynthetic` カラムはソート対象外 (boolean のソートは UX 価値が低い、フィルタで代替)。

---

## 6. 実装タスク (M1〜M5)

### M1: shared-types 拡張 (小、~10 行)
- `SuperAttendanceRecord.isSynthetic: boolean` 追加
- npm workspace の build / type-check 確認

### M2: API レスポンス拡張 (小、~3 行)
- `super-admin.ts:1040` の record builder に `isSynthetic: data.isSynthetic === true` 追加
- 関連する integration test 更新 (response.records[].isSynthetic 検証)

### M3: FE バッジ・フィルタ (中、~60 行、CSV 不要のため M3 規模縮小)
- `SyntheticBadge` コンポーネント (印刷耐性 CSS: border + text、背景非依存)
- 新規「session 種別」フィルタ state / UI (RadioGroup or segmented)
- `matchesIsSyntheticFilter` pure function (unit test 推奨)
- 既存 exitReasonOptions / 退室理由フィルタ は変更しない

### M4: Playwright E2E (中、~50 行)
- fixture: tenant に synthetic session 1 件 + 実 session 1 件をセットアップ
- 表示確認: バッジが synthetic 行のみに見える
- フィルタ確認: synthetic_only / actual_only で表示件数変化
- PDF 印字確認: `window.print()` でバッジが残ること (Playwright pdf() で印字結果検証)

### M5: ドキュメント
- ADR-027 (lesson_sessions) に **追記** (Codex 推奨): Phase 1/2 の provenance flag 採用理由に併せて Phase 3 可視化方針を記述。新規 ADR より追跡性が高い
- handoff 更新

---

## 7. テスト計画

### 7.1 単体テスト
- `matchesIsSyntheticFilter` (pure function): all / synthetic_only / actual_only × isSynthetic={true,false}

### 7.2 統合テスト (API)
- attendance-report response で record.isSynthetic が boolean で返ること
- Phase 1/2 投入前の doc (isSynthetic field 欠落) は false にマップされること

### 7.3 E2E (Playwright)
- 上記 M4

### 7.4 manual 確認 (本番運用相当)
- 長遊園テナント (Phase 2 apply 後) で 4 件にバッジが見えること
- 新規テスト提出 (Phase 1 経由) でバッジが見えること

---

## 8. リスク・代替案・OQ

### 8.1 想定リスク
| # | リスク | 対応 |
|---|-------|------|
| R1 | バッジが視覚的に主張しすぎる (運用混乱を誘発) | amber-tone (注意色だが alert ではない)、tooltip で説明、ドキュメント整備 |
| R2 | フィルタ追加で UI が複雑化 | 「session 種別」を default `all` にし、開いた時のみ選択。視覚的負担最小化 |
| R3 | CSV ヘッダ追加で既存 PDF 生成・解析が破綻 | PDF 生成側の影響範囲確認 (PR #535 で類似経験あり) |
| R4 | Phase 1/2 投入前の既存 doc で isSynthetic 欠落 | API layer で `=== true` 比較で false にマップ、FE 側は boolean 必須 |

### 8.2 代替案
| 案 | 採否 |
|---|------|
| バッジ廃止、status 列に「合成」表示 | ❌ status は LessonSessionStatus enum を表示する規約。混在は読みづらい |
| 退室理由列に「自動補完」を sentinel として表示 | ❌ exitReason は実意味 (quiz_submitted) を持つ。上書きしない |
| ツールチップのみ (バッジなし) | ❌ 視覚的に発見不能、運用補助価値が下がる |

### 8.3 Open Questions (Codex 推奨方向反映)

| # | 質問 | 推奨方向 | 根拠 |
|---|------|---------|------|
| OQ1 | バッジ表示位置 | **`entryAt` 横** | 時刻が復元由来であることを示す位置として自然、独立列は過剰 |
| OQ2 | フィルタ UI | **RadioGroup or segmented** (`all` / `synthetic_only` / `actual_only`) | Checkbox 3 状態より状態が明確 |
| OQ3 | ADR 形式 | **ADR-027 追記** | 新規 ADR にするほど新しい意思決定ではない、Phase 1/2 の provenance flag 採用理由に追記する方が追跡しやすい |

実装着手時、上記方向で進めて開発者確認を受ける。代替案が必要な場合は別途協議。

---

## 9. 着手条件

以下すべてを満たした時に M1 着手 (Codex 反映: 着手ゲートと品質ゲートの分離):

### 必須ゲート (Phase 3 着手の前提)
- ✅ Phase 2 (PR #539) 本番 apply 完了 (synthetic doc が本番に存在する → 表示確認に必要)
- ✅ Phase 2 完了後の内部画面確認 OK (長遊園 4 件補正済み)
- ✅ 開発者から「Phase 3 着手」明示指示
- ✅ Phase 3 別 Issue 起票 (#533 Phase 3 として lock-in)

### 品質確認ゲート (推奨、必須ではない)
- ⚠️ Phase 1 (PR #537) 本番動作確認 OK
  - Phase 3 自体は Phase 1/2 の挙動を信頼するだけで、独自実装は表示層のみ
  - ただし Phase 1 動作確認が未済のままだと Phase 3 表示確認時に「これは Phase 1 由来か Phase 2 由来か」の切り分けが困難
  - → 推奨だが、必須ではない

---

## 10. 推定規模・期間

| 項目 | 規模 |
|------|------|
| 変更ファイル | 4-5 ファイル (+ E2E) |
| 変更行数 | +200 行程度 (含テスト) |
| 実装期間 | 2-4 時間 |
| レビュー | safe-refactor + code-review medium (中規模 PR) + Playwright 視覚確認 |

---

## 11. 完了条件 (Definition of Done)

- [ ] shared-types / API / FE / E2E 全層実装完了
- [ ] vitest + Playwright 全 PASS
- [ ] manual 確認: 長遊園 4 件にバッジ表示
- [ ] manual 確認: 新規テスト提出で synthetic 生成 + バッジ表示
- [ ] manual 確認: `window.print()` (PDF 出力) でバッジが印字される
- [ ] ADR-027 追記完了
- [ ] handoff 更新
