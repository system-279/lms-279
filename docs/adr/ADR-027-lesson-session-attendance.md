# ADR-027: レッスンセッション出席管理

## ステータス
承認済み（2026-05-16 改訂: セッション上限を環境変数化）

## 改訂履歴
- **2026-05-21**: **動機**: PR #407 の 3h 延長後の Phase A 測定（`audit-session-force-exits.yml`）でケース E 発火は 0 件だが、再視聴中の完了経験者が `time_limit` / `pause_timeout` に該当する将来エッジケースを根本対応する。2026-05-20 で却下した「E のリセット廃止」とは異なり、本変更は初回視聴中の E は全リセット維持し、**再視聴中の永続完了経験者のみ救済する部分的拡張（新ケース E' を追加）**である。

  **変更内容**: `forceExitSession` のリセット skip 条件に **「現在 lesson の video に対する永続 `video_analytics.isComplete=true`」** を追加（`hasPersistentVideoCompletion` ヘルパー、`services/api/src/services/lesson-session.ts`）。これにより、過去にレッスンを完了済みのユーザーが再受験時に動画を再視聴して時間切れ／一時停止超過に陥っても、既存学習データ（`video_analytics` / `video_events` / `quiz_attempts` / `user_progress`）は保護される。救済対象 reason は `time_limit` / `pause_timeout` のみで、`max_attempts_failed` は受験規律破りのため永続フラグに関わらず全リセット維持（ケース F semantics）。

  **動画差し替え検知**: `getVideoByLessonId(session.lessonId)` で取得した現在 video の id が `session.videoId` と一致する場合のみ永続完了を尊重（旧 video の `isComplete` で誤救済しない）。video 削除 / 差し替え時は `logger.warn` / `logger.info` で観測可能化（`eventType=persistent_completion_skip_video_*`）。

  **例外フォールバック方針（safe-by-default）**: `getVideoAnalytics` / `getVideoByLessonId` の例外時は **true（skip reset 側）にフォールバック**。理由: 本変更の目的は完了済みデータの保護。fetch 失敗時に false → 全リセットに倒すと PR 趣旨と矛盾（transient Firestore エラーで永続データ破壊）。副作用として初回視聴中ユーザーの false positive 救済が起こり得るが、`cleanupInProgressAttempts` は走るため in_progress attempt は終端化され、次回新セッションで動画完了させれば規律装置の元の挙動に戻る。発火頻度は Cloud Logging の `errorType=persistent_completion_check_failed` で監視（alerting 設定は follow-up）。

  **規律装置の本質（初回視聴完遂の担保）は不変**で、初回視聴中（永続 `isComplete=false`）の time_limit は引き続き全リセット。

  ### ケース定義表（2026-05-21 改訂）

  | ID | 条件 | 挙動 | 再受験可否 |
  |---|---|---|---|
  | A | 不合格 + セッション内（time_limit 未到達）+ maxAttempts 未到達 | セッション継続 | ✅ 即時再受験 |
  | B | `time_limit` + `sessionVideoCompleted=true`（現セッション内で完了） | リセット skip、in_progress attempt のみ `timed_out` 化 | ✅ 新セッションで再受験 |
  | C | `browser_close`（abandoned） | リセットせず、in_progress attempt のみ `timed_out` 化 | ✅ 新セッションで再受験 |
  | D | セッション未作成（動画再生せず直接テスト送信） | activeSession=null でセッション制約スキップ | ✅ 受講期間内なら受験可 |
  | E | `time_limit` + `sessionVideoCompleted=false` + **永続 `isComplete=false`** | 全リセット（初回視聴中の規律装置） | ❌ 動画から見直し |
  | **E'**（新） | `time_limit` / `pause_timeout` + `sessionVideoCompleted=false` + **永続 `isComplete=true`**（再視聴中の完了経験者）| **リセット skip**、in_progress attempt のみ `timed_out` 化 | ✅ 新セッションで再受験 |
  | F | `max_attempts_failed`（`maxAttempts > 0 && attemptNumber >= maxAttempts`） | 全リセット（永続フラグ無視、規律破り） | ❌ 動画から見直し |

- **2026-05-20**: 現場声「テスト不合格時にいつでも再受験できる方が望ましいのではないか」を起点に再設計を検討。実コード検証で **`maxAttempts=0`（本番テナント `8vexhzpc` の全 quiz 設定。Codex review PR #407 body 参照）配下では既にケース A〜D で何度でも再受験可能** と判明。再受験不可はケース E と F のみ。E/F のリセット廃止 / 動画ゲート（ADR-019）撤廃 / 「いつでも再受験」設計変更は **規律装置（強制退室時の全リセット）を破壊する本末転倒** と判断し、いずれも不採用。3h 延長（PR #407）は対症療法として暫定維持、**恒久対応は業務側のコンテンツ設計**（レッスン単位で「動画長 + テスト所要時間 < `SESSION_DURATION_MS`」を満たす分割）で対応する。効果測定として `scripts/audit-session-force-exits.ts` + `.github/workflows/audit-session-force-exits.yml`（read-only）を追加し、ケース E の発生数を継続観察する。

  ### ケース A〜F 定義（2026-05-20 時点、historical reference）

  > **NOTE**: 本表は 2026-05-20 時点の semantics（記録目的）。**現時点の authoritative なケース定義は 2026-05-21 entry の表を参照**。本表の case E は無条件全リセットとして記載されているが、2026-05-21 改訂で `isComplete=false` 限定に変更され、新ケース E'（再視聴中の完了経験者救済）が追加されている。コード参照の行番号は edit で rot しているため、現在のコード位置は symbol 参照（`forceExitSession` / `hasPersistentVideoCompletion`）から探すこと。

  | ID | 条件（reason, sessionVideoCompleted, maxAttempts） | 挙動 | 再受験可否 | コード参照（rot 済、symbol 参照を推奨） |
  |---|---|---|---|---|
  | A | 不合格 + セッション内（time_limit 未到達）+ maxAttempts 未到達 | セッション継続 | ✅ 即時再受験 | `quiz-attempts.ts` の合格/上限到達 fall-through |
  | B | `reason=time_limit` + `sessionVideoCompleted=true` | `forceExitSession` でリセット skip、in_progress attempt のみ `timed_out` 化 | ✅ 新セッションでテスト再受験 | `lesson-session.ts#forceExitSession`（PR #134 + Issue #422） |
  | C | `reason=browser_close`（abandoned） | リセットせず、in_progress attempt のみ `timed_out` 化 | ✅ 新セッションで再受験 | `lesson-session.ts#abandonSession`（Issue #422） |
  | D | セッション未作成（後方互換） | `activeSession=null` でセッション制約スキップ | ✅ 受講期間内なら受験可 | `quiz-attempts.ts` PATCH ハンドラ（コメント明示） |
  | E | `reason=time_limit` + `sessionVideoCompleted=false` | `resetLessonDataForUser` で全リセット（**2026-05-21 改訂で永続 `isComplete=false` 限定に変更**） | ❌ 動画から見直し | `lesson-session.ts#forceExitSession` reset 分岐 |
  | F | `reason=max_attempts_failed`（`maxAttempts > 0 && attemptNumber >= maxAttempts`） | 同上、全リセット | ❌ 動画から見直し（本番 maxAttempts=0 では発火しない） | `quiz-attempts.ts` の max_attempts_failed 分岐 |

  ### 規律装置の根拠

  E/F のリセットは罰則ではなく **「1 セッション内で動画視聴→テスト送信まで完了させる」要件**（本 ADR §コンテキスト / `services/api/src/services/lesson-session.ts:201-207`）を担保する装置。E のリセット廃止 = 動画視聴強制の規律装置を撤廃 = 本末転倒。
- **2026-05-16**: セッション上限 `SESSION_DURATION_MS` および一時停止上限 `PAUSE_TIMEOUT_MS` を環境変数で上書き可能化（PR #407）。本番運用で動画 60-80 分のレッスン + テスト解答時間が 2 時間制限内に収まらない事例が複数発生（kanjikai.or.jp テナント、5/3〜5/14 で `time_limit` 強制退室 7 件）。本番は `SESSION_DURATION_MS=10800000`（3 時間）にデプロイ。不正値は `logger.error` 後にデフォルトへフォールバック。受講者向け UI 文言の「2 時間」表記は PR #408 で対応完了（`SessionRulesNotice` は `deadlineAt - entryAt` から動的算出、`ForceExitDialog` / ヘルプ / API 403 message は時間値を明示しない汎用表現に変更）。長期的には動画完了後にテスト専用タイマーに切り替える設計案（"Phase 3" として議論中）も検討。
- **2026-03-30**: 強制退室発生時にそのレッスンの学習データ（`video_analytics` / `video_events` / `quiz_attempts` / `user_progress` の該当エントリ）を完全リセットする実装を追加（PR #134、Issue #133）。`exitReason` が `pause_timeout` / `time_limit` / `max_attempts_failed` のいずれかで `forceExitSession()` が呼ばれると、`resetLessonDataForUser()` が同期実行される。**ただし `sessionVideoCompleted=true` のセッションはリセットを skip**（HTML5 video の `ended` が pause 状態を伴うため、完了後の自然な pause タイムアウトでデータが全消去されるのを防止）。受講者は強制退室後に白紙状態から再受講可能。

## コンテキスト
受講者の出席を「入室打刻（動画再生開始）」「退室打刻（テスト送信）」で管理する要件がある。不正防止のため、一時停止 15 分超過および入室からセッション上限（`SESSION_DURATION_MS`、デフォルト 2 時間 / 本番運用は 3 時間）超過で強制退室をかける。強制退室時はそのレッスンの学習データを完全リセットし、白紙状態から再受講可能とする（PR #134）。

## 決定
`lesson_sessions` コレクションを新設し、既存の `video_analytics` / `user_progress` の上にオーバーレイする形で出席を管理する。

### セッションライフサイクル
```
(なし) → [動画再生] → active → [テスト送信] → completed
                          ├── [一時停止 PAUSE_TIMEOUT_MS]      → force_exited (pause_timeout)
                          ├── [入室から SESSION_DURATION_MS]    → force_exited (time_limit)
                          ├── [テスト受験回数上限超過で不合格]  → force_exited (max_attempts_failed)
                          └── [ブラウザ閉じ]                    → abandoned
```

`force_exited` 各遷移では `resetLessonDataForUser()` が同期実行され、該当レッスンの動画進捗・テスト解答記録（`video_analytics` / `video_events` / `quiz_attempts` / `user_progress`）を完全リセットする（PR #134、Issue #133）。受講者は再入室で白紙からやり直す。

ただし `sessionVideoCompleted=true` のセッションについては以下の例外がある:
- `pause_timeout` 要求は受理せず active を維持（HTML5 video `ended` が pause を伴うため）
- `forceExitSession()` が呼ばれた場合もリセットを skip（完了後のリセットを防止）

セッション制限値（デフォルト / 本番運用）:
- `SESSION_DURATION_MS`: 2 時間 / 3 時間（`10800000`）
- `PAUSE_TIMEOUT_MS`: 15 分 / 15 分（本番でも未設定 → default）

### 入室打刻
- トリガー: 動画再生ボタン押下（最初のplayイベント）
- ページ表示だけでは打刻しない

### 退室打刻
- トリガー: テスト送信
- `quiz-attempts` の PATCH ハンドラでセッションを `completed` に更新

### 強制退室
- 一時停止 `PAUSE_TIMEOUT_MS`（デフォルト 15 分）: クライアントサイドカウントダウン → サーバーに force-exit 送信
- セッション上限 `SESSION_DURATION_MS`（デフォルト 2 時間、本番運用 3 時間）: クライアントカウントダウン + サーバーサイドでテスト送信時に検証
- 強制退室時はレッスン学習データを完全リセット（PR #134、`sessionVideoCompleted=true` のセッションは skip）。受講者は新規セッション（再入室）で白紙状態から再受講できる

### UI表示
- 各レッスンページに受講ルールを常時表示
- セッション開始後は制限時刻を動的カウントダウンで表示
  - 残り30分〜10分: 黄色警告
  - 残り10分以下: 赤色警告（パルスアニメーション）

## 根拠
- **別コレクション**: セッションは多対一（1レッスンに複数セッション）のため `user_progress` への埋め込みは不適切
- **累積analytics維持**: `video_analytics` はAdmin向け累積データとして残し、セッション概念と分離
- **サーバーサイド検証**: クライアントのカウントダウンだけでなく、テスト送信時にサーバーでセッション上限（`SESSION_DURATION_MS`）を検証（クライアント改ざん防止）
- **ルール明記**: 受講者の混乱を防ぐため、各レッスンページにルールを常時表示
- **env による上限調整**: ハードコード固定では現場運用差（動画長 + テスト所要時間）に追従できないため、`SESSION_DURATION_MS` / `PAUSE_TIMEOUT_MS` を環境変数化（PR #407）
- **強制退室時のデータリセット**: 旧データが残ると再受講時の進捗判定が壊れ、受講者が「再テストできない」状態に陥るため、強制退室と同期で完全リセット（PR #134）

## 影響
- 新コレクション: `lesson_sessions`
- 新API: POST/GET/PATCH `/lesson-sessions`
- 既存API拡張: PATCH `/quiz-attempts/:attemptId` にセッション検証追加
- フロントエンド: 4つの新コンポーネント（SessionRulesNotice, SessionTimer, PauseTimeoutOverlay, ForceExitDialog）
- Firestoreインデックス: `(userId, lessonId, status)`, `(courseId, status, entryAt)`
- 環境変数: `SESSION_DURATION_MS` / `PAUSE_TIMEOUT_MS`（CLAUDE.md / Cloud Run env vars 反映）
- DataSource API 拡張: `resetLessonDataForUser()`（InMemory / Firestore 両実装）— 強制退室時に `video_analytics` / `video_events` / `quiz_attempts` / `user_progress` の該当エントリを batched delete
