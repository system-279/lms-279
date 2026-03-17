# ADR-015: 倍速禁止の実装方針

## ステータス
承認済み

## コンテキスト
受講者が倍速再生で視聴時間を短縮することを防止する必要

## 決定
クライアント側でratechangeイベント検出時に即座にplaybackRate=1.0にリセット。サーバー側で違反回数を記録（speedViolationCount）

## 根拠
二重防御（クライアント即時リセット + サーバー記録）。DevToolsでの改竄はサーバーサイドのheartbeat検証で検出

## 影響
VideoPlayerコンポーネントにratechangeリスナー実装。video_analyticsにspeedViolationCountフィールド。管理画面で違反回数表示
