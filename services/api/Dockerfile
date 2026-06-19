# Node 24.17.0 の http.Agent keep-alive regression (Premature close, nodejs/node#63989) 回避のため
# パッチ固定。floating tag `node:24-slim` は再ビルド時に最新 24.x を引き込み、gaxios 経由の
# IAM signBlob が壊れて GCS 署名 URL 生成 (動画再生 / PDF) が 500 になる本番障害を起こした
# (Session 76/78/79 で再発、root cause)。修正版 Node リリース後に追従すること。
FROM node:24.16.0-slim

WORKDIR /app

# ワークスペースルート構造をコピー（依存解決に必要）
COPY package.json package-lock.json ./
COPY packages/shared-types ./packages/shared-types
COPY services/api/package.json services/api/tsconfig.json ./services/api/

# ワークスペース依存関係をインストール
RUN npm ci -w @lms-279/shared-types -w @lms-279/api

# shared-typesをビルド（型定義生成）
RUN npm run build -w @lms-279/shared-types

# APIソースをコピーしてビルド
COPY services/api/src ./services/api/src
COPY services/api/assets ./services/api/assets
RUN npm run build -w @lms-279/api

# 不要ファイル削除（assets は PDF 生成で必要なため残す）
RUN rm -rf services/api/src packages/shared-types/src node_modules/.cache

# 本番用依存関係のみ再インストール
RUN npm ci --omit=dev -w @lms-279/shared-types -w @lms-279/api

WORKDIR /app/services/api

EXPOSE 8080

CMD ["node", "dist/index.js"]
