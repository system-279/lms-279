# ADR-003: モノレポ（npm workspaces）

## ステータス
承認済み

## コンテキスト
複数サービス（API, Notification, Web, E2E）の管理方式

## 決定
npm workspacesによるモノレポ構成。services/*, web, e2e をワークスペースとして管理

## 根拠
共有型定義の一元管理、依存関係の整合性維持、CI/CDの簡素化。turborepo等の追加ツール不要

## 影響
ルートpackage.jsonでワークスペーススクリプト実行。各サービスは独立したpackage.json保持
