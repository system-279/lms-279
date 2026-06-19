---
name: feedback-upload-pr-real-smoke-required
description: アップロード上限・GCS 経路を変更する PR は、マージ前に本番デプロイ後の実機 smoke を必ず実施する
metadata:
  type: feedback
---

PDF / 動画 / 講座資料など GCS 直接 PUT 経路を含む PR、特にアップロード上限値を変更する PR は、PR Test plan の `[ ]` 項目に「マージ後デプロイ → 上限値前後 (例: 上限の 80% 程度) の実機 upload smoke」を必ず含めること。**この項目を `[x]` にしない限りマージ承認を依頼しない**。

**Why:**
- 2026-06-19、PDF アップロード上限を 150 MB → 300 MB に引き上げた PR (#577) の Test plan に「マージ後デプロイ → 230 MB 程度の PDF を upload して動作確認 (現場連絡前)」を `[ ]` で記載しながら、AI 側が「ROI 低」と判定して未実施でマージ
- 直後にユーザーが 212.7 MB の PDF (300 MB 上限内) をアップロードした際、IAM Credentials API `signBlob` が `Premature close` (TCP 早期切断、transient) で失敗。旧 `withGcsErrorMapping` が `timeout|ECONNRESET` のみ判定でこれを素通りし、Express errorHandler → 画面に `[object Object]` 表示
- 単体テストでは検知できないクラスの障害 (ネットワーク層 transient / 署名 URL 生成段階 / FE BE エラー形式不一致) で、**本番実機 upload 1 回で必ず検知できた**性質の事象
- 復旧 PR #579 で transient retry 拡大 + apiFetch 正規化を入れたが、根本原因は smoke 未実施
- AI が ROI 低と独断判定して却下したのは 4 原則 §1 (executor 越権) 違反

**How to apply:**
- 変更ファイル例: `services/api/src/services/lesson-resource.ts` / `services/api/src/services/video-*.ts` / `web/components/master/MasterLessonPdfUploader.tsx` / `web/lib/upload.ts` / GCS 関連 env (`GCS_VIDEO_BUCKET` / `GCS_UPLOAD_BUCKET` / `GCS_RESOURCE_BUCKET`)
- Test plan に書く文言例 (マージ前必須):
  - [ ] マージ後デプロイ → super-admin で N MB 程度 (上限の 70-80%) の PDF/動画を実機 upload 成功確認
  - [ ] 開発者ツールで `gcs_transient_retry` ログまたは 200 系レスポンス観測 (転送経路の健全性確認)
- Test plan を AI が ROI 評価で削除/格下げしない。必要性判断は decision-maker 領分 (4 原則 §1)
- catchup フェーズで「却下候補 → 本番実機 smoke (ROI 低)」と書くのは AI の越権。Test plan に書かれた smoke は「条件待ち (smoke 実施前提)」or 「即着手 (smoke 必須)」に分類する
- smoke 完了報告がない PR は **「セッション終了可」判定を出さない**

**関連:**
- 本番障害 PR: #574 (50→150 MB) / #577 (150→300 MB) ともに smoke 未実施でマージ
- 復旧 PR: #579 (transient retry + apiFetch 正規化、Test plan 必須 smoke 含む)
- 関連 ADR: ADR-036 (PDF 配信)
- グローバル: `~/.claude/memory/feedback_test_plan_execution.md` の強化版
