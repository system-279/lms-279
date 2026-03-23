# ADR-027: レッスンセッション出席管理

## ステータス
承認済み

## コンテキスト
受講者の出席を「入室打刻（動画再生開始）」「退室打刻（テスト送信）」で管理する要件がある。不正防止のため、一時停止15分超過および入室から2時間超過で強制退室（セッションリセット）をかける。

## 決定
`lesson_sessions` コレクションを新設し、既存の `video_analytics` / `user_progress` の上にオーバーレイする形で出席を管理する。

### セッションライフサイクル
```
(なし) → [動画再生] → active → [テスト送信] → completed
                          ├── [一時停止15分] → force_exited (pause_timeout)
                          ├── [2時間経過] → force_exited (time_limit)
                          └── [ブラウザ閉じ] → abandoned
```

### 入室打刻
- トリガー: 動画再生ボタン押下（最初のplayイベント）
- ページ表示だけでは打刻しない

### 退室打刻
- トリガー: テスト（クイズ）送信
- `quiz-attempts` の PATCH ハンドラでセッションを `completed` に更新

### 強制退室
- 一時停止15分: クライアントサイドカウントダウン → サーバーに force-exit 送信
- 2時間制限: クライアントカウントダウン + サーバーサイドでテスト送信時に検証
- 強制退室後は新規セッション（再入室）が必要

### UI表示
- 各レッスンページに受講ルールを常時表示
- セッション開始後は制限時刻を動的カウントダウンで表示
  - 残り30分〜10分: 黄色警告
  - 残り10分以下: 赤色警告（パルスアニメーション）

## 根拠
- **別コレクション**: セッションは多対一（1レッスンに複数セッション）のため `user_progress` への埋め込みは不適切
- **累積analytics維持**: `video_analytics` はAdmin向け累積データとして残し、セッション概念と分離
- **サーバーサイド検証**: クライアントのカウントダウンだけでなく、テスト送信時にサーバーで2時間制限を検証（クライアント改ざん防止）
- **ルール明記**: 受講者の混乱を防ぐため、各レッスンページにルールを常時表示

## 影響
- 新コレクション: `lesson_sessions`
- 新API: POST/GET/PATCH `/lesson-sessions`
- 既存API拡張: PATCH `/quiz-attempts/:attemptId` にセッション検証追加
- フロントエンド: 4つの新コンポーネント（SessionRulesNotice, SessionTimer, PauseTimeoutOverlay, ForceExitDialog）
- Firestoreインデックス: `(userId, lessonId, status)`, `(courseId, status, entryAt)`
