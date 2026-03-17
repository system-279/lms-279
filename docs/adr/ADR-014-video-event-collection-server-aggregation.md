# ADR-014: 動画イベント収集とサーバーサイド集計

## ステータス
承認済み

## コンテキスト
動画視聴の完了判定を確実に行う必要がある

## 決定
クライアントは生イベント（play/pause/seek/ended/heartbeat/ratechange/visibility）を送信し、サーバーが視聴範囲・完了率を算出

## 根拠
クライアント側の完了判定は改竄リスクがある。サーバーサイドでheartbeatイベントから視聴区間を算出し、重複区間をマージしてcoverageRatioを計算

## 影響
video_eventsコレクションに生イベント保存。video_analyticsにwatchedRanges, coverageRatio, isComplete等を集計
