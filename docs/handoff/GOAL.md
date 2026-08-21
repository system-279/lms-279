---
updated: 2026-08-21 (Phase 1a計画中: Codexセカンドオピニオン2巡目で重大指摘、計画再改訂待ち)
---

## 現在のミッション
LMSのテスト(quiz) CRUD操作を、Claudeのリモートmcpコネクタ経由でチームメンバーがclaude.ai/Claude Desktop/Claude Codeから実行できるようにする。既存API(services/api)は一切変更せず、新規Cloud RunサービスがOAuth 2.1認可サーバー(内部でFirebase Google サインインへ委譲)を兼ねる設計。

## 背景・why
開発者から「テストの登録・編集をClaude Codeからスキルで簡単にできるようにしたい」との相談。検討の結果、チームメンバー全員が claude.ai/Desktop/Code のいずれからでも使える「組織カスタムリモートMCPコネクタ」方式を採用（Team plan組織連携MCPはOwnerが1回登録すれば全クライアント自動配布、公式ドキュメント確認済み）。

plan mode で計画策定 → Codexセカンドオピニオン(MCP版、effort=high)で高重要度指摘（super admin横断CRUDリスク・監査ログの過大申告・同時編集ロストアップデート等）を受け全面改訂 → 承認。計画全文: `/Users/yyyhhh/.claude/plans/planmode-whimsical-curry.md`（Codexセカンドオピニオン適用ログ含む）。判断材料の図解: grip HTML（パスは前セッションのscratchpad配下、セッション終了後は失われるため次セッションでの再確認は計画ファイルを正とする）。

**Phase 0実装中の設計転換**: 当初想定していたMCP TS SDK (v2)の認可サーバーヘルパー(`mcpAuthRouter`)がlegacy化されていることが判明し、`oidc-provider`(panva、OpenID Certified、DCR/PKCE対応)を内部採用する方式へ転換。

## 完了の定義（Phase 0）
- OAuthハンドシェイク(discovery/DCR/PKCE付き認可コードフロー/bearer認証)がローカル統合テストで動作する → 済（`npm run test -w @lms-279/mcp` 9件PASS）
- Cloud Runへの実デプロイが成功し、公開URLでdiscovery/401応答が正しく返る → 済（`https://mcp-3zcica5euq-an.a.run.app`、curl実証確認済み）
- 2系統の独立コードレビュー(codex review effort=high + pr-review-toolkit:code-reviewer)でCritical指摘が0件になっている → 済（両者が独立検出したCritical欠陥=Cloud Run起動時crash等、全件修正・実機再検証済み。PR #636マージ済み）
- Claude Code / claude.ai / Claude Desktop の少なくとも1つから実際に接続し、pingツールが呼べる → 済（本セッションでClaude Codeから `authenticate` → OAuth認証 → `ping` 呼び出しで `pong` 応答を実機確認）

## 進行中のtasks
- [x] plan mode で計画策定、Codexセカンドオピニオンで全面改訂（元計画: `planmode-whimsical-curry.md`）
- [x] grip HTMLで判断材料を可視化
- [x] Phase 0: services/mcp新設、oidc-provider + @modelcontextprotocol/express実装
- [x] Phase 0: ローカル統合テスト9件PASS（PKCE成功系・異常系・Cloud Run想定回帰テスト含む）
- [x] Phase 0: PR #636作成 → codex review + pr-review-toolkit 2系統レビュー実施
- [x] Phase 0: 両レビューが独立検出したCritical欠陥（Cloud Run起動時crash、fetchOidcMetadataのbindアドレス誤り）を修正、Docker実機でCloud Run相当環境を再現し検証
- [x] Phase 0: PR #636マージ（squash、main反映）
- [x] Phase 0: Cloud Run自動デプロイ成功、公開URLでの実疎通をcurlで確認
- [x] Phase 0: `claude mcp add`でローカルスコープ登録 → OAuth認証 → pingツール呼び出し確認 → 済（`pong`応答確認）
- [x] Phase 1a: plan mode でスコープ縮小版計画を策定（決裁者承認: super admin不使用方針・スコープ縮小方針の2点）、計画ファイル `/Users/yyyhhh/.claude/plans/buzzing-rolling-whisper.md` に記録
- [x] Phase 1a: Codexセカンドオピニオン1巡目（6件指摘、4件をoidc-provider実ソースで裏取りし計画に反映。詳細は計画ファイル「Codexセカンドオピニオンの反映」節）
- [ ] Phase 1a: Codexセカンドオピニオン2巡目 — **PR1(永続化)を PR2(実Firebaseサインイン)より先に単独デプロイする設計自体が危険**という新規の重大指摘あり。計画の再改訂が未完了（下記中断点参照）
- [ ] Phase 1a: 決裁者への計画再承認 → 実装着手（未着手、コード変更は本セッションでゼロ）
- [ ] Phase 1以降: 計画ファイル参照（quiz CRUDツール実装、本番コネクタ登録等）

## 🔄 中断点（in-flight）
**対象タスク**: Phase 1a「Codexセカンドオピニオン2巡目 → 計画再改訂 → 決裁者への再承認」（進行中のtasksの3〜4番目）

**直前の状態**:
1. Phase 0完了後、決裁者から「Phase 1に着手して」との指示を受け、plan mode で Phase 1a（縮小スコープ版）の計画を策定。計画ファイル: `/Users/yyyhhh/.claude/plans/buzzing-rolling-whisper.md`
2. 決裁者確認済みの2判断: (a) MCP経由でのsuper admin テナント横断操作は「使わせない」、(b) Phase 1のスコープは縮小版（Firebaseリフレッシュトークン暗号化永続化・鍵ローテーション・DCR濫用対策本実装・最小権限SA設計はPhase 1bへ先送り）
3. Codexセカンドオピニオン1巡目（`mcp__codex__codex`, plan mode, effort=high）で6件の指摘。4件（jwks秘密鍵同梱・`consume()`のTOCTOUレース・`offline_access`既定scope・Firestore TTL未配備）は `node_modules/oidc-provider` の実ソースで裏取りし事実確認のうえ計画に反映済み。詳細は計画ファイル「Codexセカンドオピニオンの反映」節
4. Codexセカンドオピニオン2巡目で、改訂版計画に対し**新規の重大指摘**: 「PR1（Firestore永続化adapter）をPR2（devInteractions→実Firebaseサインイン）より先に単独で本番デプロイする設計自体が危険」。理由: PR1稼働中はまだdevInteractions（任意文字列でログイン可能なダミー画面）が有効なため、攻撃者が任意のaccountIdでSession/Grantを作成でき、それがFirestoreに永続化される（oidc-provider既定のSession/Grant TTLは14日）。PR2デプロイ後もこの偽装Session/Grantが最大14日間生き残り、実Firebase認証を経ずに悪用されうる
5. この指摘を独立検証済み: `node_modules/oidc-provider/lib/helpers/defaults.js:409-417` で `SessionTTL`/`GrantTTL` とも `14 * 24 * 60 * 60`（14日）であることを確認。また計画中の `gcloud firestore fields ttl-policies create` というコマンドは実際には存在せず、正しくは `gcloud firestore fields ttls update expiresAt --collection-group=mcp_oauth_store --enable-ttl` であることも `gcloud ... --help` で確認済み（両方とも事実、計画側の誤り）
6. ここでユーザーからcontext残量低下によりhandoff指示を受け、**計画の再改訂（PR1/PR2の順序入れ替え等）はまだ着手していない**

**次の一手**: 計画ファイル `/Users/yyyhhh/.claude/plans/buzzing-rolling-whisper.md` を、Codexセカンドオピニオン2巡目の指摘を反映して再改訂する。有力な方向性（次セッションで検討・決裁者確認のうえ選択）:
- (a) PR1とPR2の実装順序を入れ替える（devInteractions→実Firebaseサインイン置き換えを先に、永続化を後に。永続化が有効になる時点で偽装Sessionが存在し得ない状態にする）
- (b) PR1とPR2を本番デプロイ上は同時に有効化する（コードレビュー上は2PRのままでも、Cloud Runへのデプロイ・トラフィック切替はPR2完成まで待つ）
- (c) PR1単独デプロイを許容する代わりに、PR2デプロイ直前に `mcp_oauth_store` を完全消去 + Cookie鍵ローテーション + 既存DCRクライアント失効の手順を追加する

再改訂後は plan mode で `ExitPlanMode` → 決裁者の承認を得てから実装（PR1コード着手）に進む。**本セッションではservices/mcp配下のコードは一切変更していない**（すべてplan mode内での計画策定のみ）。

**検証コマンド**（次セッション開始時にこれで現状確認）:
```bash
cat /Users/yyyhhh/.claude/plans/buzzing-rolling-whisper.md
git status --short services/mcp/  # 変更ゼロのはず
gh pr list --state open  # Phase 1a関連PRはまだ存在しないはず
```

## Phase 0完了の経緯（本セッション、2026-08-21）
実クライアント接続で当初の想定になかった不具合が2件連続発覚し、いずれも修正・実機再検証済み。

1. **PR #638**: `invalid_target: resource indicator is missing, or unknown`。原因は `oidc-provider` の `resourceIndicators.getResourceServerInfo` 未実装（既定は常にエラーを投げるスタブ）。既存テストは `resource` パラメータを送らないフローしか検証しておらず未検出だった
2. **PR #639**: PR #638適用後、今度は `access_denied`（"no scope was granted"）。原因は実クライアントが `scope` パラメータを一切送らない（`resource`のみ）ため、oidc-providerの missing-scope 判定が発火せず consent 後も grant に何も追加されない挙動。`getResourceServerInfo` 内で `resource` 指定時に `scope` 未指定なら `"openid"` を補うよう修正

いずれも fix適用前RED→適用後GREENの独立再実行証拠を確認済み。最終的にPlaywright MCPでdevInteractionsのダミーログイン〜consentを実施し、`ping`ツール呼び出しで`pong`応答を実機確認して完了。

**既知の残存制約（Phase 1で解消予定、恒久登録はしないこと）**: `oidc-provider`はインメモリadapter（`services/mcp/src/oidc.ts`コメント参照）のため、Cloud Runの再デプロイ・インスタンス入れ替わりでDCR登録済みクライアントが失効する。本セッションでも2回再デプロイ後に`claude mcp remove`→`claude mcp add`での再登録が必要だった。Firestore等永続adapterへの置き換えまでは組織カスタムコネクタとしての本番配布は行わないこと。

## 🔔 監視中
- PR #620（`QUIZ_REQUIRE_ACTIVE_SESSION=true`本番切替のロールバック弁、2026-08-20作成）は観察期間を置いて維持する方針（2026-08-21、決裁者確認）。`/quizzes/:quizId/attempts`の409(`session_required`/`session_time_exceeded`)発生率異常、または正当な受講者からの問い合わせが確認されない限りmergeしない。観察期間終了の目安なし
- **Phase 0のCloud Runサービスは devInteractions（ダミー認証）が有効なまま**。組織カスタムコネクタとしての恒久登録はまだ行っていない。Phase 1aでFirebase Google サインインに置き換えるまで、チーム展開しないこと
- **Phase 1a計画は未確定（上記中断点参照）**。PR1/PR2の実装順序次第でファイル構成・デプロイ手順が変わりうるため、次セッションは計画ファイルの再改訂から再開すること。現時点のplan agentの詳細設計（Firestore adapterのスキーマ等）は本セッションのサブエージェント出力にのみ存在し、計画ファイル本体には要約のみが反映されている点に注意
