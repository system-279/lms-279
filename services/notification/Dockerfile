# Node 24.17.0 の http.Agent keep-alive regression (Premature close, nodejs/node#63989) 回避のため
# パッチ固定。floating tag は再ビルド時に最新 24.x を引き込むため、全サービスで固定を揃える。
# 修正版 Node リリース後に追従すること。
FROM node:24.16.0-slim

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
EXPOSE 8081

# 起動コマンド
CMD ["node", "dist/index.js"]
