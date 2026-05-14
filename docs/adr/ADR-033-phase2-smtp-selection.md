# ADR-033: Phase 2 受講者進捗 PDF メール送信 - SMTP プロバイダ選定とドメイン認証整備

- Status: **Rejected** (2026-05-14、ユーザー要望と相違)
- Date: 2026-05-14
- Deciders: system-279, sanwaminamihonda@gmail.com
- 関連: ADR-032 (Phase 1 採択), ADR-034 (Phase 2 採用方式), Issue #346 (Phase 2 起票)

> **本 ADR は不採用となりました。Phase 2 の最終採用方式は [ADR-034](./ADR-034-phase2-gmail-draft.md) を参照してください。**
>
> 末尾の [Rejected 理由 (2026-05-14)](#rejected-理由-2026-05-14) セクションに不採用の経緯を記録しています。

## Context

ADR-032 Phase 2 は「スーパー管理者が `tenants/{id}.ownerEmail` 宛に受講者進捗 PDF を自動メール送信する」機能。Phase 1 (PDF 生成・ダウンロード) は PR #345 で完了済、Phase 2 着手前に下記 2 つの判断が必要:

1. **SMTP プロバイダ**: Workspace SMTP relay vs SendGrid
2. **送信ドメイン認証**: 現在 `279279.net` は SPF / DKIM / DMARC が全て未整備

## 送信ドメイン現状 (2026-05-14 dig 確認)

| レコード | 設定状況 |
|---------|---------|
| MX | `1 smtp.google.com.` ✅ (Workspace 受信稼働中) |
| SPF (`TXT 279279.net`) | ❌ `google-site-verification` のみ、`v=spf1 ...` なし |
| DKIM (`TXT google._domainkey`) | ❌ レコードなし |
| DKIM (`TXT selector1._domainkey`) | ❌ レコードなし |
| DMARC (`TXT _dmarc.279279.net`) | ❌ レコードなし |

このまま Phase 2 を展開すると以下のリスクが顕在化する:
- Gmail / Outlook の受信側で SPF/DKIM 失敗 → spam フォルダ直行
- Yahoo Mail / Gmail の 2024-02 以降の送信ガイドライン違反 (大量送信時)
- DMARC reject ポリシーを持つ受信ドメインで全 reject

**Phase 2 着手前にドメインオーナー (sanwaminamihonda@gmail.com) による DNS レコード追加が必須**。

## Decision (推奨案)

### 1. SMTP プロバイダ: **Google Workspace SMTP relay** を推奨

理由:
- 既に Workspace 契約済 (`279279.net` で `smtp.google.com` 利用中)
- 追加コスト 0 円 (Workspace ライセンス内)
- Phase 2 想定送信 volume が小さい (莞爾会 1 テナント・月 10-30 通想定)
- Nodemailer による SMTP 抽象化で、将来 SendGrid 等への切替容易

### 2. 送信元アドレス: `lms-noreply@279279.net` (Workspace で新規発行)

理由:
- 受信者の返信を blackhole にして誤運用を防ぐ
- Phase 1 で出力される PDF と紐付くため、ドメインと用途が明確
- `lms@279279.net` を採用すると、人が応答する印象を与え運用負荷増

### 3. DNS 整備順序 (Phase 2 実装前のブロッカー)

| Step | レコード | 値 | 担当 |
|------|----------|----|----|
| 1 | TXT `279279.net` | `v=spf1 include:_spf.google.com ~all` | ドメインオーナー |
| 2 | Workspace 管理コンソール | DKIM 鍵生成 → 表示された TXT 値を控える | ドメインオーナー |
| 3 | TXT `google._domainkey.279279.net` | (Step 2 で取得した値) | ドメインオーナー |
| 4 | Workspace 管理コンソール | DKIM 認証 ON 切替 | ドメインオーナー |
| 5 | TXT `_dmarc.279279.net` | `v=DMARC1; p=quarantine; rua=mailto:sanwaminamihonda@gmail.com; pct=100; adkim=s; aspf=s` | ドメインオーナー |
| 6 | dig 検証 + Gmail への送信テスト | SPF=pass / DKIM=pass / DMARC=pass | system-279 |

注: Step 5 の `p=quarantine` は Phase 2 リリース直後の初期値。1 週間以上 rua レポートを監視して問題なければ `p=reject` に強化する。

### 4. Phase 2 アーキテクチャ (確定事項を ADR-032 から引き継ぎ)

- `services/api` → PDF 生成 + GCS `gs://lms-279-pdf-tmp/{tenantId}/{userId}/{requestId}.pdf` に保存 (TTL 7 日)
- `services/api` → Firestore `tenants/{id}/pdf_send_logs/{requestId}` に PII 最小化ログ
- `services/api` → `services/notification` に `object path` を渡す (Base64 ではなく)
- `services/notification` → GCS から PDF 読み出し、Nodemailer で SMTP relay 経由送信
- レート制限: スーパー管理者 60 通/時、テナント 30 通/日
- idempotency key (`requestId`) で二重送信防止
- 失敗時はエラーコード表示 + PDF ダウンロードへフォールバック

## Alternatives Considered

### A. SendGrid

| 項目 | Workspace SMTP relay | SendGrid |
|------|---------------------|----------|
| 月額コスト | **0 円** (既存) | Free 100 通/日, Essentials $19.95/月 |
| 送信元制約 | Workspace ドメイン内のみ | 任意 (要 SPF/DKIM 認証) |
| レート制限 | 10,000 通/日/アカウント | プランによる |
| bounce 監視 | Postmaster Tools (集計)、個別 bounce は SMTP 応答のみ | Webhook + ダッシュボード (個別追跡) |
| 設定の手間 | Workspace 管理画面で 5-10 分 | アカウント作成 + ドメイン認証 + API key 管理 |
| 切替容易性 | Nodemailer SMTP transport → SendGrid SMTP transport に変更可 | (同左) |

**SendGrid 不採用理由**: Phase 2 の volume (月数十通) では Free でも十分だが、追加サービス契約 + API key 管理 + Secret Manager 設定の運用負荷が増える。bounce 監視の優位性は Phase 2 では best-effort で許容できる範囲。

### B. Amazon SES

不採用理由:
- AWS アカウントを別途運用する必要 (現在 GCP 一本)
- ismap 観点で GCP 内完結方針 (memory `feedback_ismap_gcp_only.md`) に反する
- Workspace で十分な機能を有償別サービスに置換する合理性なし

### C. Cloud Run + Postfix 自前運用

不採用理由:
- Cloud Run はアウトバウンド SMTP の port 25 が closed
- 587 (submission) で外部 relay を利用する必要があり、結局 Workspace か SendGrid 等に依存
- 自前運用するメリットなし

## Consequences

### 良い影響

- 追加コスト 0 円で Phase 2 リリース可能
- SPF/DKIM/DMARC 整備により Phase 2 以外の Workspace メール (Calendar 招待等) の到達性も向上
- Nodemailer の抽象化で将来の SendGrid 切替に向けた逃げ道を維持

### 注意点・残存リスク

- DNS 整備はドメインオーナー手作業のため、Phase 2 実装着手前のリードタイムが発生する (見積 30-60 分)
- Workspace SMTP relay のレート制限 (10,000 通/日/アカウント) は Phase 2 想定 volume なら十分だが、将来複数テナント拡大で月数千通を超えたら SendGrid 切替を再評価
- bounce 監視は Postmaster Tools の集計レベル。個別メールの bounce 追跡は `services/notification` 側で SMTP 応答コードを `pdf_send_logs.errorCode` に記録する best-effort で対応
- `pdf-misfire.md` runbook は本 ADR 採択後、Phase 2 実装と並行して整備

### Phase 2 実装着手のブロッカー

以下を満たすまで Phase 2 のコード実装には着手しない:

- [ ] 本 ADR-033 が Accepted
- [ ] DNS Step 1-5 完了
- [ ] DNS Step 6 検証 PASS (Gmail への送信テストで SPF=pass / DKIM=pass / DMARC=pass)
- [ ] Workspace で `lms-noreply@279279.net` 発行

## Rejected 理由 (2026-05-14)

本 ADR 起票直後にユーザー (sanwaminamihonda@gmail.com) と要件再確認した結果、当初の Phase 2 オーダー (Issue #346) が想定していた「自動送信」のイメージが本 ADR の設計と異なることが判明し、不採用となった。

### ユーザー想定とのギャップ

- ユーザーの希望: **スーパー管理者がログイン中の Google アカウントの Gmail メーラー画面が立ち上がり、その場で送信内容を確認・編集して手動送信**
- 本 ADR の設計: バックエンド SMTP relay で **新規共有アドレス `lms-noreply@279279.net` から自動送信** (送信元固定)

### 本 ADR を不採用とする主要理由

1. **送信元アドレスの相違**: ユーザーはログイン中のスーパー管理者本人のアドレスから送信したい。本 ADR の `lms-noreply@279279.net` ではこれを満たせない
2. **DNS 整備の不要化**: ユーザー希望方式 (Gmail API draft) は Workspace 既存設定のみで動作するため、SPF/DKIM/DMARC の新規整備自体が不要になる
3. **新規アドレス発行の不要化**: 専用アドレス発行 + Secret Manager + Cloud Run SA 設計が丸ごと不要
4. **確認・編集の主導権**: Gmail 下書き UI ならスーパー管理者が送信前に本文を自由編集できる。本 ADR の「確認モーダル」は限定的な編集機能しか提供できない

### 採用された代替案

[ADR-034: Phase 2 受講者進捗 PDF Gmail 下書き作成](./ADR-034-phase2-gmail-draft.md) を新規起票し、Gmail API `users.drafts.create` 経由でスーパー管理者本人の Gmail 下書きフォルダに PDF 添付付きメールを作成する方式を採用。

### 本 ADR で記録した検証結果の引き継ぎ

以下は ADR-034 でも利用できる調査結果のため、参考情報として残置する:

- 送信ドメイン `279279.net` の DNS 設定状況 (Context 節)
- Workspace SMTP relay / SendGrid / SES / Postfix 自前運用の比較 (Alternatives Considered 節)

ADR-034 採用後は SMTP プロバイダ選定や DNS 整備が不要になるため、上記検証結果は将来「テナント招待メール」「障害通知メール」等の別ユースケース検討時に再利用される可能性がある。

## 関連

- ADR-032: Phase 1 採択 (PR #345 マージ済)
- ADR-034: Phase 2 採用方式 (Gmail API draft)
- Issue #346: Phase 2 起票
- ADR-010: フラットエラーレスポンス形式 (Phase 2 メール送信失敗時のエラー形式と整合)
- memory: `feedback_ismap_gcp_only.md` (個人情報を扱うプロジェクトの GCP 内完結方針)
