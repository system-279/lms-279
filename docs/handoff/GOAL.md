---
updated: 2026-08-21 (MCPコネクタ化ミッション新設・Phase 0完了)
---

## 現在のミッション
LMSのテスト(quiz) CRUD操作を、Claudeのリモートmcpコネクタ経由でチームメンバーがclaude.ai/Claude Desktop/Claude Codeから実行できるようにする。既存API(services/api)は一切変更せず、新規Cloud RunサービスがOAuth 2.1認可サーバー(内部でFirebase Google サインインへ委譲)を兼ねる設計。

## 背景・why
開発者から「テストの登録・編集をClaude Codeからスキルで簡単にできるようにしたい」との相談。検討の結果、チームメンバー全員が claude.ai/Desktop/Code のいずれからでも使える「組織カスタムリモートMCPコネクタ」方式を採用（Team plan組織連携MCPはOwnerが1回登録すれば全クライアント自動配布、公式ドキュメント確認済み）。

plan mode で計画策定 → Codexセカンドオピニオン(MCP版、effort=high)で高重要度指摘（super admin横断CRUDリスク・監査ログの過大申告・同時編集ロストアップデート等）を受け全面改訂 → 承認。計画全文: `/Users/yyyhhh/.claude/plans/planmode-whimsical-curry.md`（Codexセカンドオピニオン適用ログ含む）。判断材料の図解: grip HTML（パスは前セッションのscratchpad配下、セッション終了後は失われるため次セッションでの再確認は計画ファイルを正とする）。

**Phase 0実装中の設計転換**: 当初想定していたMCP TS SDK (v2)の認可サーバーヘルパー(`mcpAuthRouter`)がlegacy化されていることが判明し、`oidc-provider`(panva、OpenID Certified、DCR/PKCE対応)を内部採用する方式へ転換。

## 完了の定義（Phase 0のみ、Phase 1-4は計画ファイル参照）
- OAuthハンドシェイク(discovery/DCR/PKCE付き認可コードフロー/bearer認証)がローカル統合テストで動作する → 済（`npm run test -w @lms-279/mcp` 9件PASS）
- Cloud Runへの実デプロイが成功し、公開URLでdiscovery/401応答が正しく返る → 済（`https://mcp-3zcica5euq-an.a.run.app`、curl実証確認済み）
- 2系統の独立コードレビュー(codex review effort=high + pr-review-toolkit:code-reviewer)でCritical指摘が0件になっている → 済（両者が独立検出したCritical欠陥=Cloud Run起動時crash等、全件修正・実機再検証済み。PR #636マージ済み）
- Claude Code / claude.ai / Claude Desktop の少なくとも1つから実際に接続し、pingツールが呼べる → **未達（進行中）**

## 進行中のtasks
- [x] plan mode で計画策定、Codexセカンドオピニオンで全面改訂
- [x] grip HTMLで判断材料を可視化
- [x] Phase 0: services/mcp新設、oidc-provider + @modelcontextprotocol/express実装
- [x] Phase 0: ローカル統合テスト9件PASS（PKCE成功系・異常系・Cloud Run想定回帰テスト含む）
- [x] Phase 0: PR #636作成 → codex review + pr-review-toolkit 2系統レビュー実施
- [x] Phase 0: 両レビューが独立検出したCritical欠陥（Cloud Run起動時crash、fetchOidcMetadataのbindアドレス誤り）を修正、Docker実機でCloud Run相当環境を再現し検証
- [x] Phase 0: PR #636マージ（squash、main反映）
- [x] Phase 0: Cloud Run自動デプロイ成功、公開URLでの実疎通をcurlで確認
- [ ] Phase 0: `claude mcp add`でローカルスコープ登録 → OAuth認証 → pingツール呼び出し確認（決裁者が実施中、下記中断点参照）
- [ ] Phase 1以降: 計画ファイル参照（OAuth認可サーバー本実装、権限方針確定、quiz CRUDツール実装、本番コネクタ登録等）

## 🔄 中断点（in-flight）
**対象タスク**: Phase 0「実クライアントからの接続確認」（進行中のtasks 最後から2番目）

**直前の状態**:
1. 決裁者が `claude mcp add --transport http lms-quiz-mcp-phase0 https://mcp-3zcica5euq-an.a.run.app/mcp` を実行済み（成功、`/Users/yyyhhh/.claude.json` にproject-local scopeで登録済み）
2. 既存の対話セッション内で `/mcp` を実行したが、そのセッションは登録前に起動していたため一覧に `lms-quiz-mcp-phase0` が表示されず（設定はセッション起動時ロードのため）。加えてダイアログはEscで閉じられた（`MCP dialog dismissed`）
3. 決裁者へ「セッションを再起動してから `/mcp` を再実行し、一覧から `lms-quiz-mcp-phase0` を選択して認証する」よう案内済み。まだ再実行結果の報告なし

**次の一手**: 決裁者からの `/mcp` 再実行結果・pingツール呼び出し結果を待つ。成功したら Phase 0 完了 → GOAL.mdの完了の定義を全て`済`にし、Phase 1着手の要否を決裁者に確認する。失敗したら `claude mcp list` / `claude mcp get lms-quiz-mcp-phase0` の出力を確認してトラブルシュートする。

**検証コマンド**（次セッション開始時にこれで現状確認）:
```bash
claude mcp list
claude mcp get lms-quiz-mcp-phase0
curl -s https://mcp-3zcica5euq-an.a.run.app/.well-known/oauth-authorization-server | head -5
```

## 🔔 監視中
- PR #620（`QUIZ_REQUIRE_ACTIVE_SESSION=true`本番切替のロールバック弁、2026-08-20作成）は観察期間を置いて維持する方針（2026-08-21、決裁者確認）。`/quizzes/:quizId/attempts`の409(`session_required`/`session_time_exceeded`)発生率異常、または正当な受講者からの問い合わせが確認されない限りmergeしない。観察期間終了の目安なし
- **Phase 0のCloud Runサービスは devInteractions（ダミー認証）が有効なまま**。組織カスタムコネクタとしての恒久登録はまだ行っていない。Phase 1でFirebase Google サインイン + ドメイン検証に置き換えるまで、チーム展開しないこと
