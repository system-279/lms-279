# データモデル

## Firestore構造

全データは `tenants/{tenantId}/` 配下に格納。

### 継承コレクション（参考プロジェクトから）

| コレクション | 用途 |
|-------------|------|
| `users` | ユーザー情報 |
| `allowed_emails` | アクセス許可リスト |
| `user_settings` | ユーザー設定 |
| `notification_policies` | 通知ポリシー |
| `notification_logs` | 通知ログ |
| `auth_error_logs` | 認証エラーログ |
| `course_enrollment_settings` | 受講期間設定（テナント×コース単位） |

### 新規コレクション

#### courses/{id}
| フィールド | 型 | 説明 |
|-----------|------|------|
| name | string | 講座名 |
| description | string | 説明 |
| status | string | draft / published / archived |
| lessonOrder | string[] | レッスンID順序配列 |
| passThreshold | number | 合格基準（%） |
| createdBy | string | 作成者ID |
| createdAt | Timestamp | 作成日時 |
| updatedAt | Timestamp | 更新日時 |

#### lessons/{id}
| フィールド | 型 | 説明 |
|-----------|------|------|
| courseId | string | 所属コースID |
| title | string | レッスンタイトル |
| order | number | 表示順 |
| hasVideo | boolean | 動画あり |
| hasQuiz | boolean | テストあり |
| videoUnlocksPrior | boolean | 前レッスン完了必須 |
| createdAt | Timestamp | 作成日時 |
| updatedAt | Timestamp | 更新日時 |

#### videos/{id}
| フィールド | 型 | 説明 |
|-----------|------|------|
| lessonId | string | 所属レッスンID |
| courseId | string | 所属コースID |
| sourceType | string | gcs / external_url / google_drive |
| sourceUrl | string | 外部URL（sourceType=external_url時） |
| gcsPath | string | GCSパス（sourceType=gcs or google_drive時） |
| driveFileId | string? | Google DriveファイルID（sourceType=google_drive時） |
| importStatus | string? | pending / importing / completed / error（google_drive時） |
| importError | string? | インポートエラーメッセージ |
| durationSec | number | 動画長（秒） |
| requiredWatchRatio | number | 完了判定比率（default 0.95） |
| speedLock | boolean | 倍速禁止（default true） |
| createdAt | Timestamp | 作成日時 |
| updatedAt | Timestamp | 更新日時 |

#### video_events/{id}
| フィールド | 型 | 説明 |
|-----------|------|------|
| videoId | string | 動画ID |
| userId | string | ユーザーID |
| sessionToken | string | 再生セッショントークン |
| eventType | string | play/pause/seek/ended/heartbeat/ratechange/visibility_hidden/visibility_visible |
| position | number | 再生位置（秒） |
| seekFrom | number | シーク元位置（seek時のみ） |
| playbackRate | number | 再生速度 |
| timestamp | Timestamp | サーバー受信時刻 |
| clientTimestamp | number | クライアント送信時刻 |
| metadata | object | 追加情報 |

#### video_analytics/{id} (ID=userId_videoId)
| フィールド | 型 | 説明 |
|-----------|------|------|
| watchedRanges | array | 視聴済み区間 [{start, end}] |
| totalWatchTimeSec | number | 合計視聴時間（秒） |
| coverageRatio | number | カバー率（0-1） |
| isComplete | boolean | 完了判定 |
| seekCount | number | シーク回数 |
| pauseCount | number | 一時停止回数 |
| totalPauseDurationSec | number | 合計一時停止時間 |
| speedViolationCount | number | 倍速違反回数 |
| suspiciousFlags | string[] | 不審フラグ |
| updatedAt | Timestamp | 最終更新 |

#### quizzes/{id}
| フィールド | 型 | 説明 |
|-----------|------|------|
| lessonId | string | 所属レッスンID |
| courseId | string | 所属コースID |
| title | string | テストタイトル |
| passThreshold | number | 合格基準（default 70%） |
| maxAttempts | number | 最大受験回数（default 3） |
| timeLimitSec | number | 制限時間（秒、null=無制限） |
| randomizeQuestions | boolean | 問題順ランダム |
| randomizeAnswers | boolean | 選択肢順ランダム |
| requireVideoCompletion | boolean | 動画完了必須 |
| questions | array | 問題配列（上限50問） |

questions配列の各要素:
| フィールド | 型 | 説明 |
|-----------|------|------|
| id | string | 問題ID |
| text | string | 問題文 |
| type | string | single / multi |
| options | array | 選択肢 [{id, text, isCorrect}] |
| points | number | 配点 |
| explanation | string | 解説（採点後表示） |

#### quiz_attempts/{id}
| フィールド | 型 | 説明 |
|-----------|------|------|
| quizId | string | テストID |
| userId | string | ユーザーID |
| attemptNumber | number | 受験回数 |
| status | string | in_progress / submitted / timed_out |
| answers | object | {questionId: optionIds[]} |
| score | number | 得点（%） |
| isPassed | boolean | 合否 |
| startedAt | Timestamp | 開始時刻 |
| submittedAt | Timestamp | 提出時刻 |

#### user_progress/{id} (ID=userId_lessonId)
| フィールド | 型 | 説明 |
|-----------|------|------|
| videoCompleted | boolean | 動画完了 |
| quizPassed | boolean | テスト合格 |
| quizBestScore | number | テスト最高得点 |
| lessonCompleted | boolean | レッスン完了 |
| updatedAt | Timestamp | 最終更新 |

#### course_progress/{id} (ID=userId_courseId)
| フィールド | 型 | 説明 |
|-----------|------|------|
| completedLessons | number | 完了レッスン数 |
| totalLessons | number | 全レッスン数 |
| progressRatio | number | 進捗率（0-1） |
| isCompleted | boolean | コース完了 |
| updatedAt | Timestamp | 最終更新 |

#### lesson_sessions/{id}（出席管理）
| フィールド | 型 | 説明 |
|-----------|------|------|
| userId | string | ユーザーID |
| lessonId | string | レッスンID |
| courseId | string | コースID |
| videoId | string | 動画ID |
| sessionToken | string | video_eventsとの紐付けトークン |
| status | string | active / completed / force_exited / abandoned |
| entryAt | Timestamp | 入室打刻（動画再生開始時） |
| exitAt | Timestamp? | 退室打刻（テスト送信 or 強制退室時） |
| exitReason | string? | quiz_submitted / pause_timeout / time_limit / browser_close |
| deadlineAt | Timestamp | entryAt + 2時間（事前計算） |
| pauseStartedAt | Timestamp? | 現在の一時停止開始時刻 |
| longestPauseSec | number | セッション中の最長一時停止秒数 |
| sessionVideoCompleted | boolean | セッション内で動画完了したか |
| quizAttemptId | string? | 完了時のテストattempt ID |
| createdAt | Timestamp | 作成日時 |
| updatedAt | Timestamp | 更新日時 |

#### course_enrollment_settings/{courseId}（受講期間設定 — テナント×コース単位）
| フィールド | 型 | 説明 |
|-----------|------|------|
| courseId | string | コースID |
| enrolledAt | string | 受講開始日（スーパー管理者が設定） |
| quizAccessUntil | string | テスト受験期限（enrolledAt + 2ヶ月、自動計算） |
| videoAccessUntil | string | 動画視聴期限（enrolledAt + 1年、自動計算） |
| createdBy | string | 設定したスーパー管理者のメールアドレス |
| updatedAt | string | 更新日時 |
