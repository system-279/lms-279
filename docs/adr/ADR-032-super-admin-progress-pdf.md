# ADR-032: スーパー管理者向け 受講者進捗 PDF 出力

- Status: Accepted
- Date: 2026-05-13
- Deciders: system-279, sanwaminamihonda@gmail.com

## Context

莞爾会 長遊園 様 (LMS-279 莞爾会テナント) で deadlineBaseDate ベースの受講期限管理が稼働（Session 15, PR #340 / #342 / #343）。スーパー管理者が「テナント内の特定受講者の進捗をまとめた紙資料」を発行できる手段が必要になった。当面はスーパー管理者がダウンロードして手渡し／別途メール添付する運用とし、将来的にテナント管理者 (`tenants/{id}.ownerEmail`) へ自動送信する余地を残す。

## Decision

スーパー管理者専用の進捗 PDF 出力機能を **2 Phase に分割**して導入する。本 ADR は Phase 1 (PDF 生成・ダウンロード) の判断を確定し、Phase 2 (メール送信) は別 ADR で確定する。

### Phase 1 採用事項

- PDF 生成方式: **サーバーサイド `@react-pdf/renderer`** (4.5.1)
- 日本語表示: Noto Sans JP Variable Font (Google Fonts, SIL OFL 1.1) を `services/api/assets/fonts/` に同梱
- 配置画面: `/super/progress` の各受講者行に「PDF」リンク → 専用印刷プレビューページ `/super/progress/[tenantId]/[userId]/print`
- 出力項目: 7 セクション (profile / deadline / summary / lessons / quiz / pace / video) をチェックボックスで ON/OFF、初期値は全 ON
- 推奨ペース: 週レッスン数 + 1 日あたり視聴分を併記
- API エンドポイント: `POST /api/v2/super/tenants/:tenantId/users/:userId/progress-pdf` (`requireSuperAdmin`)
- PDF サイズ上限: 5MB (超過時 413)
- 越境チェック: DataSource は tenant scope (`tenants/{tenantId}/` prefix) のため `getUserById(userId)` が null なら 404 `user_not_in_tenant`
- データ集約は DataSource 経由 (ADR-028 InMemoryDataSource テスト戦略を維持)、tenant doc (name / ownerEmail) のみ Firestore 直接アクセス (tenant doc は tenant scope の外)

### Phase 2 (確定は別 ADR、本 ADR では論点だけ記録)

- 送信先: `tenants/{id}.ownerEmail`
- 送信手段: メール添付 (Nodemailer 想定、SMTP プロバイダ未確定)
- トリガー: スーパー管理者が「生成・送信」ボタンを手動押下、確認モーダルで宛先・本文プレビューを承認
- PDF は GCS に一時保存 (TTL 7 日)、services/api → services/notification には Base64 ではなく object path を渡す
- Firestore `tenants/{id}/pdf_send_logs` に PII 最小化したログを残す (sentToHash sha256 / requestId idempotency / 90 日 TTL)
- 送信レート制限 (管理者 60 通/時、テナント 30 通/日)
- SMTP プロバイダ選定: Google Workspace SMTP relay vs SendGrid を bounce 監視可否で決定

## 推奨ペース計算境界仕様 (Phase 1 確定)

`Pace.status` で表示分岐:

| status | 条件 | lessonsPerWeek | minutesPerDay |
|---|---|---|---|
| `completed` | `remainingLessons === 0` | null | null |
| `expired_both` | 動画期限 < now AND テスト期限 < now | null | null |
| `expired_video` | 動画期限 < now (テスト受験のみ可) | null | null |
| `expired_quiz` | テスト期限 < now (動画視聴のみ可) | 計算 | 計算 |
| `ongoing` | 両期限内 | 計算 | 計算 |

計算式:
- `remainingDays = min(daysRemainingVideo, daysRemainingQuiz)` のうち 0 以上のもの
- `lessonsPerWeek = max(1, ceil(remainingLessons / (remainingDays / 7)))`
- `minutesPerDay = max(1, ceil(remainingVideoSec / remainingDays / 60))`
- 残り動画秒の欠損対応: video_analytics 未記録なら `durationSec × requiredWatchRatio (0.95) - 0` を必要量として加算

JST 統一は API 側で実施 (FE で日付演算するとタイムゾーンずれリスクあり)。

## Alternatives Considered

1. **ブラウザ印刷 (window.print() + @media print)**: 新規依存ゼロで Phase 1 単独なら成立するが、Phase 2 の自動メール送信で PDF ファイルを取得できないため不採用
2. **Puppeteer (HTML → PDF)**: レイアウト自由度高いが Cloud Run で 500MB+ メモリ・cold start 悪化のため不採用
3. **pdfkit**: 帳票ライブラリとして強力だがレイアウトを手続的に組む必要があり、React コンポーネント化と比べ保守性が低いため不採用
4. **クライアントサイド @react-pdf/renderer**: Phase 1 単独なら成立するが、Phase 2 でメール送信時にサーバー側で再生成が必要になる二重実装を避けるためサーバーサイド一択

## Consequences

### 良い影響

- Cloud Run 256MB の安全マージン内で動作 (テスト計測: heapUsed 増分 < 200MB)
- ADR-028 InMemoryDataSource テスト戦略を維持できる (PDF 生成も同じ DataSource で再現可能)
- Phase 2 のメール送信は services/notification の本格実装になるが、PDF 生成ロジックは Phase 1 で確立済のため再実装不要

### 注意点・残存リスク

- Noto Sans JP Variable Font は約 9.6MB あり、コンテナイメージサイズに影響 (Cloud Run プル時間 +1-2 秒程度)。必要なら今後サブセット化を検討
- Phase 2 着手前に SMTP プロバイダ・SPF/DKIM/DMARC 設定の確定が必須
- 越境チェックは DataSource が tenant scope であることに依存。今後 DataSource API を pivot する際は `tenants/{tenantId}/users/{userId}` の path 存在確認に切替する

## 関連

- ADR-028 (DataSource Test Strategy): InMemoryDataSource 中心の統合テストを踏襲
- ADR-029 (Enrollment Timezone Policy): 期限の JST 日末扱いと整合
- PR #340 (deadlineBaseDate): 期限起算日に追従
- Plan: `~/.claude/plans/pdf-steady-sun.md` (実装計画と Codex セカンドオピニオン反映)
