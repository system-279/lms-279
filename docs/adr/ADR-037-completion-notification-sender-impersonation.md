# ADR-037: 自動完了通知の送信元 impersonation 経路 (SendAs によるエイリアス送信)

- Status: **Accepted**
- Date: 2026-05-21
- Deciders: system-279, sanwaminamihonda@gmail.com
- 関連: ADR-026 (Google Workspace Integration / DWD 基盤), 設計仕様書 `docs/specs/2026-05-20-completion-notification-design.md` (OQ-2 解決), Session 39 ハンドオフ

## Context

DXcollege 自動完了通知システム (PR #442 で着手) は、設計仕様書段階で送信元を `dxcollege@279279.net` (Google Workspace の Group エイリアス) に固定する前提で設計していた。実現方式は **DWD なりすまし送信** (Domain-Wide Delegation で `subject=dxcollege@279279.net`、scope=`gmail.send` で OAuth token 取得 → `gmail.users.messages.send`)。

設計仕様書 §10 OQ-2 (Codex セカンドオピニオン Important-2 由来) で「**`dxcollege@279279.net` が Google Group エイリアスの場合、DWD subject として impersonation 可能か実機検証必須**」と Open Question 化されていた。Phase 0-A-4 として smoke check workflow を用意し、Phase 1 着手前に実機検証を実行した。

### Smoke 検証ログ (2026-05-20 〜 2026-05-21)

| 回 | 実行時刻 (JST) | subject | scope | 結果 | 解釈 |
|---|---|---|---|---|---|
| 1 | 2026-05-20 13:41 | `dxcollege@279279.net` | `gmail.send` | 401 `unauthorized_client` | 初回、DWD 反映待ち or Group エイリアス問題どちらか未確定 |
| 2 | 2026-05-21 04:48 | `dxcollege@279279.net` | `gmail.send` | 401 `unauthorized_client` | 15h 経過しても変化なし、「DWD 反映待ち」仮説否定 |
| **3** | **2026-05-21 04:52** | **`system@279279.net`** | **`gmail.send`** | **✅ OAuth 通過** | **`gmail.send` scope 自体は Workspace に登録済、Group エイリアスへの impersonation が原因と確定** |

実機検証用 workflow run ID: 26166362814 / 26186034548 / 26186218233。

### 確定した原因

Google Workspace の DWD impersonation は **個別ユーザー mailbox** に対してのみ動作する。`dxcollege@279279.net` のような Group エイリアス (mailbox を持たない alias) は subject として認められず、token endpoint が `unauthorized_client` で拒否する。

これは Google 公式ドキュメントには明示されていないが、Group エイリアスに対する OAuth subject impersonation は仕様上 mailbox 存在を前提とする挙動として運用界隈で知られる事象。

## Decision

設計仕様書の代替案として明示されていた 2 案 (§10 OQ-2) のうち、**案 X: SendAs 設定** を採用する。

### 実装方針

1. **DWD subject**: `system@279279.net` (本田様の実ユーザー mailbox、Cloud Run env `DXCOLLEGE_DISPATCH_SUBJECT` で設定)
2. **From ヘッダ**: `dxcollege@279279.net` (Cloud Run env `DXCOLLEGE_SENDER_EMAIL` で設定、SendAs 経由で偽装)
3. **OAuth scope**: `https://www.googleapis.com/auth/gmail.send` (変更なし、既存 DWD 登録済み)
4. **Workspace 側設定**: `system@279279.net` の Gmail 設定で `dxcollege@279279.net` を SendAs として登録 (確認ステップ: Gmail の「アカウント」→「他のメールアドレスを追加」)
5. **送信時の Gmail API 呼出し**: `users.messages.send` を `userId=me` (subject の mailbox = `system@279279.net` の Sent folder) で実行

### 受講者から見える挙動

- メール `From:` ヘッダ: `dxcollege@279279.net`
- 返信先 (`Reply-To:`): `dxcollege@279279.net` (SendAs の既定)
- スレッド/送信履歴: `system@279279.net` の Sent folder に蓄積

### 不採用案

#### Alt-1 (案 Y): 実ユーザー mailbox 化

`dxcollege@279279.net` を Group ではなく Google Workspace 実 User として再作成。専用 mailbox と独自ライセンスを持たせる。

- **不採用理由**: Workspace ライセンス追加コスト (月額 ~¥1,000)、Group → User 切り替えで既存受信メンバーへの影響確認が必要、本田様作業が増える
- **再評価条件**: スタッフ複数人で送信履歴を共有する運用要件が顕在化したら見送り判断を再考

#### Alt-2: 外部 SMTP サービス (SES / SendGrid 等)

メール基盤を Gmail から外部 SMTP に切り替える。

- **不採用理由**: ADR-033 (Phase 2 SMTP selection) で既に「Gmail API 一択」と判断済。スタッフが Gmail UI で sent log を確認できる運用利点を維持
- **再評価条件**: Gmail API のレート制限や spam 判定で運用障害が発生したら再考

## Consequences

### 良い影響

- 追加コストなし (Workspace ライセンス追加不要、既存 SendAs 機能で実現)
- DWD 認可は既存 `gmail.send` scope そのまま、Workspace 管理コンソールでの追加 scope 登録不要
- smoke 検証で OAuth 通過が確認済の subject (`system@279279.net`) を利用するため、本番リスクが低い

### 受容するトレードオフ

- 送信履歴 (Sent folder) が `system@279279.net` (本田様の業務 mailbox) に蓄積される。スタッフ間で sent log 共有はできない (将来運用要件として顕在化したら Alt-1 へ移行)
- `system@279279.net` の退職・引き継ぎ時には DWD subject 切り替えが必要 (ADR としては運用 runbook 化を推奨)
- Cloud Run env を 1 つ追加 (`DXCOLLEGE_DISPATCH_SUBJECT`)、混同を防ぐため env 命名で `_SUBJECT` (DWD impersonation 対象) と `_SENDER_EMAIL` (MIME From) を厳密に分離

### 既存実装への影響

- 設計仕様書 §1, §3, §6.4, §8.1, §8.2, §10 (OQ-2) を本 ADR 採用に合わせて改訂 (本 PR で実施)
- 実装計画 §Phase 0 / §Cloud Run env を更新
- Phase 1 残部の `gmail-client.ts` は `getGmailClientForSender(subject, from)` の 2 引数化 (subject と from を分離)
- smoke script は `DXCOLLEGE_DISPATCH_SUBJECT` env / `--subject-email` フラグの新設

## Open Questions / 将来の再評価トリガ

- **OQ-X**: SendAs 設定後の実機 send mode smoke (Gmail API での From ヘッダが SendAs として認められるか) — 本 PR merge 後、本田様の Workspace SendAs 設定完了を待って実行
- **再評価条件 1**: `system@279279.net` を SendAs オーナーから別 mailbox に切替えたい運用要件 → Alt-1 (実 User 化) 再評価
- **再評価条件 2**: 受講者の返信が `dxcollege@279279.net` に届いた際の対応フロー (Group メンバー全員 vs 専用担当者) → 運用 runbook で確定
- **再評価条件 3**: Gmail API spam 判定で SendAs 経由送信が拒否されるケースが運用後に観測されたら、Postmaster Tools での到達率モニタリングを追加検討
