FROM node:24-slim AS builder

WORKDIR /app

# ワークスペースルート構造をコピー（依存解決に必要）
COPY package.json package-lock.json ./
COPY packages/shared-types ./packages/shared-types
COPY web/package.json ./web/

# ワークスペース依存関係をインストール
RUN npm ci -w @lms-279/shared-types -w @lms-279/web

# shared-typesをビルド（型定義生成）
RUN npm run build -w @lms-279/shared-types

# Webソースをコピー
COPY web/ ./web/

# Build-time env vars for Next.js
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_AUTH_MODE=dev
ARG NEXT_PUBLIC_FIREBASE_API_KEY
ARG NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
ARG NEXT_PUBLIC_FIREBASE_PROJECT_ID
ARG NEXT_PUBLIC_USER_ID
ARG NEXT_PUBLIC_USER_ROLE
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_AUTH_MODE=$NEXT_PUBLIC_AUTH_MODE
ENV NEXT_PUBLIC_FIREBASE_API_KEY=$NEXT_PUBLIC_FIREBASE_API_KEY
ENV NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=$NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
ENV NEXT_PUBLIC_FIREBASE_PROJECT_ID=$NEXT_PUBLIC_FIREBASE_PROJECT_ID
ENV NEXT_PUBLIC_USER_ID=$NEXT_PUBLIC_USER_ID
ENV NEXT_PUBLIC_USER_ROLE=$NEXT_PUBLIC_USER_ROLE

RUN npm run build -w @lms-279/web

FROM node:24-slim AS runner

WORKDIR /app

ENV NODE_ENV=production

# Copy standalone output - handle different possible structures
COPY --from=builder /app/web/.next/standalone ./standalone-temp

# Move files to correct location (including hidden dirs like .next)
RUN if [ -d "standalone-temp/web" ]; then \
      mv standalone-temp/node_modules ./node_modules && \
      cp -r standalone-temp/web/. ./ && \
      rm -rf standalone-temp; \
    else \
      cp -r standalone-temp/. ./ && \
      rm -rf standalone-temp; \
    fi

# Copy static files to .next/static (required for standalone)
COPY --from=builder /app/web/.next/static ./.next/static

# Copy public directory from builder (screenshots, etc.)
COPY --from=builder /app/web/public ./public

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
