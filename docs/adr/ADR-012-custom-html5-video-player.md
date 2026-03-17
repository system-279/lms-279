# ADR-012: カスタムHTML5動画プレイヤー

## ステータス
承認済み

## コンテキスト
LMSの中核機能として動画視聴管理が必要。倍速禁止・イベント追跡を完全に制御する必要がある

## 決定
Video.js/Plyr等のライブラリは不使用。HTML5 Video APIを直接制御するカスタムReactコンポーネントを実装

## 根拠
倍速禁止のratechangeイベント即時リセット、詳細なイベント追跡（play/pause/seek/ended/heartbeat/ratechange/visibility）はライブラリのカスタマイズよりも直接制御が確実。バンドルサイズ削減にも寄与

## 影響
VideoPlayer.tsx（メインラッパー）、VideoControls.tsx（カスタムUI、速度変更ボタンなし）、VideoEventTracker.tsx（イベント収集+バッチ送信）の3コンポーネント構成
