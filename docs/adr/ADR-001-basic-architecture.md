# ADR-001: 基本アーキテクチャ（Cloud Run + Firestore）

## ステータス
承認済み

## コンテキスト
LMSの基本インフラ選定。参考プロジェクト（classroom-check-in）で実績のある構成を踏襲

## 決定
Cloud Run（コンテナ実行）+ Firestore（NoSQLデータベース）を基盤とする

## 根拠
サーバーレス運用でインフラ管理コスト最小化。Firestoreのリアルタイム機能とスケーラビリティがLMS要件に適合。参考プロジェクトで実証済み

## 影響
RDBMSのJOINが使えないため、データモデル設計で非正規化が必要
