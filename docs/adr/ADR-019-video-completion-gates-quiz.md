# ADR-019: 動画完了がテストアクセスをゲート

## ステータス
承認済み（2026-08-19 改訂: テスト任意化 ADR-040、スキップAPIにも動画ゲートを無条件適用）

## 改訂履歴

- **2026-08-19（テスト任意化、ADR-040）**: **動機**: テストを受験せずスキップできる `POST /quizzes/:quizId/skip`（Stage 3）を新設するにあたり、動画視聴の必須性（本ADRの決定）を維持できるか設計判断が必要だった。**決定**: スキップAPIでも動画完了ゲートを `quiz.requireVideoCompletion` の値によらず**無条件適用**する。テスト自体は任意化するが動画視聴は任意化しない、という方針を維持するため。既存の `POST /quizzes/:quizId/attempts`（受験開始）のゲート挙動（`requireVideoCompletion=true`のテストのみ適用）は変更していない。

## コンテキスト
動画を視聴せずにテストだけ受験することを防止する必要

## 決定
video_analytics.isComplete=trueの確認後にのみテスト開始を許可

## 根拠
動画視聴は学習の必須プロセス。完了判定はサーバーサイドで算出済み（ADR-014）

## 影響
POST /quizzes/:quizId/attempts でvideo_analyticsを検証。requireVideoCompletion=trueのテストのみゲート適用。POST /quizzes/:quizId/skip（テスト任意化、ADR-040）では requireVideoCompletion の値によらず無条件でゲート適用
