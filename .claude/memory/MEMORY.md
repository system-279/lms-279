# lms-279 プロジェクト固有 Memory

## Test plan / smoke 必須化
- GCS upload 経路を変更する PR (上限変更含む) は実機 smoke 必須、AI の ROI 評価で却下不可 → [feedback_upload_pr_real_smoke_required.md](./feedback_upload_pr_real_smoke_required.md)

## 依存バージョン固定方針
- Dockerfile / package.json engines はパッチまで明示固定 (floating tag 禁止)、GitHub Actions は中期的に SHA-pin 検討 → [feedback_lms_floating_tag_avoidance.md](./feedback_lms_floating_tag_avoidance.md)
