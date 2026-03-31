FROM node:24-slim

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
RUN npm run build -w @lms-279/api

# 不要ファイル削除
RUN rm -rf services/api/src packages/shared-types/src node_modules/.cache

# 本番用依存関係のみ再インストール
RUN npm ci --omit=dev -w @lms-279/shared-types -w @lms-279/api

WORKDIR /app/services/api

EXPOSE 8080

CMD ["node", "dist/index.js"]
