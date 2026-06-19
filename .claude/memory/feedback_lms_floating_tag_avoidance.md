---
name: feedback-lms-floating-tag-avoidance
description: 依存バージョンの floating tag (Dockerfile / GitHub Actions / package.json engines) はパッチまで明示固定する
metadata:
  type: feedback
---

依存バージョンに floating tag (主要には Docker base image / GitHub Actions の `@vN` / package.json engines の `>=`) を使うと、再ビルド時に予期しないパッチ / マイナーを引き込み、本番稼働中の挙動が変わる。本プロジェクトでは原則として floating tag を禁止し、パッチバージョンまで明示固定する。

**Why:**

2026-06-19、Docker base image を `node:24-slim` (floating タグ) としていたため、再デプロイ時に Node 24.17.0 を引き込み、`http.Agent` keep-alive regression によって GCS 署名 URL 生成 (`signBlob`) が `Premature close` で 500 を返す本番障害が発生した。同日内に同根の症状 (動画 / PDF) で複数 PR を消費し、最後に Docker base image を `node:24.16.0-slim` にパッチ固定して真の根治に至った。floating tag は 1 日のうちに root cause を入れ替える可能性があり、smoke 通過 = 永続的健全性ではないことを実証した事例。

**How to apply:**

- **Dockerfile の `FROM`**: パッチまで明示固定する (例: `node:24.16.0-slim`)。本リポジトリは PR #583 で `services/api/Dockerfile` / `services/notification/Dockerfile` / `web/Dockerfile` (builder + runner) の 4 箇所を `node:24.16.0-slim` に統一済
- **`package.json` の `engines.node`**: パッチまで明示固定する (`"node": "24.16.0"`)。`>=` 表記は floating tag と同等のリスクがあるため避ける
- **`.github/workflows/*.yml` の `uses:`**: 現状は `@v6` / `@v3` / `@v7` の floating メジャータグ。中期的には SHA-pin (`uses: actions/checkout@<sha>`) が理想だが、即座の必須化は dependabot 設定との整合性検討が要るため別途検討対象とする。GitHub Actions は破壊的変更ペースが Node ほど速くないため、Dockerfile / engines よりは優先度低
- 新 PR で floating tag を導入していないかは、レビュー段階で目視確認する。CI での自動検出は将来課題

**関連:**

- 起源: 2026-06-19 同根再発事案 (Docker base image floating tag による Node minor 自動引き込みで signBlob Premature close 多発)
- 関連 PR: 動画 / PDF 各経路の transient retry 対症療法 → Docker base image パッチ固定で根治
- グローバル参照: [feedback_consecutive_failure_redesign.md](../../../.claude/memory/feedback_consecutive_failure_redesign.md) (同根再発の連続失敗判定境界)
