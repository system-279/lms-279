FROM node:24-slim

WORKDIR /app

# package.jsonとtsconfig.jsonをコピー
COPY package.json ./
COPY tsconfig.json ./

# 依存関係をインストール
RUN npm install

# ソースコードをコピー
COPY src ./src

# TypeScriptをビルド
RUN npm run build

# 不要なファイルを削除
RUN rm -rf src node_modules/.cache

# 本番用依存関係のみ再インストール
RUN npm ci --omit=dev

# ポートを公開
EXPOSE 8080

# 起動コマンド
CMD ["node", "dist/index.js"]
