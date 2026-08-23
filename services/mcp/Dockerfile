# Node 24.17.0 の http.Agent keep-alive regression (Premature close, nodejs/node#63989) 回避のため
# パッチ固定。floating tag は再ビルド時に最新 24.x を引き込むため、全サービスで固定を揃える。
# 修正版 Node リリース後に追従すること。
FROM node:24.16.0-slim

WORKDIR /app

# ワークスペースルート構造をコピー（依存解決に必要。services/api/Dockerfileと同型。
# Phase 2aで@lms-279/shared-typesへ依存したため、単独ディレクトリのnpm installでは
# 解決できなくなった。docker buildはリポジトリルートをビルドコンテキストとして
# 実行すること — .github/workflows/deploy.yml の deploy-mcp job 参照。
# codex review P1指摘、2026-08-23）。
COPY package.json package-lock.json ./
COPY packages/shared-types ./packages/shared-types
COPY services/mcp/package.json services/mcp/tsconfig.json ./services/mcp/

# ワークスペース依存関係をインストール
RUN npm ci -w @lms-279/shared-types -w @lms-279/mcp

# shared-typesをビルド（型定義生成）
RUN npm run build -w @lms-279/shared-types

# MCPソースをコピーしてビルド
COPY services/mcp/src ./services/mcp/src
RUN npm run build -w @lms-279/mcp

# 不要ファイル削除
RUN rm -rf services/mcp/src packages/shared-types/src node_modules/.cache

# 本番用依存関係のみ再インストール
RUN npm ci --omit=dev -w @lms-279/shared-types -w @lms-279/mcp

WORKDIR /app/services/mcp

# ポートを公開
EXPOSE 8082

# 起動コマンド
CMD ["node", "dist/index.js"]
