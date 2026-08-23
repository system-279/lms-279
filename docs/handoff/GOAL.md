---
updated: 2026-08-23 (Phase 1b-1 PR A完了・マージ・デプロイ・実機確認済み。Phase 2a (PR B) 着手が次のタスク)
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
- [x] Phase 1a: Codexセカンドオピニオン2巡目（PR1/PR2デプロイ順序の重大指摘）を受け計画再改訂 → 決裁者承認（PR1=認証の正しさを先に、PR2=永続化を後に）
- [x] Phase 1a PR1: devInteractions → 実Firebase Googleサインイン実装、テスト27件PASS、codex review 2巡+pr-review-toolkit 3系統セカンドオピニオン全反映、PR #641マージ済み
- [x] Phase 1a PR1 デプロイ後の手動作業: Firebase Console → Authentication → Authorized domains へ `mcp-3zcica5euq-an.a.run.app` を追加 → 済（Playwright MCPで実機操作、決裁者承認済み。追加後の一覧に`mcp-3zcica5euq-an.a.run.app`(Custom)が表示されることを確認）
- [x] Phase 1a PR1 実機確認: 実際にGoogleアカウントでサインイン → ping→pong確認 → 済（2026-08-22、`claude mcp add --transport http mcp https://mcp-3zcica5euq-an.a.run.app/mcp`でローカル登録→セッション再起動で反映→`/mcp`から認証開始→開発者の実Googleアカウントでサインイン・consent許可→`Authentication successful`表示→`ping`ツール呼び出しで`pong`応答を実機確認。ローカルscope登録は稼働中セッションに動的反映されず`claude --continue`での再起動が必要だった点、自動ブラウザ(Playwright)でのinteraction URL再訪問はセッション期限切れを招くため以降は決裁者自身のブラウザ操作に切り替えた点を教訓として記録）
- [x] Phase 1a PR2: Firestore永続adapter + Secret Manager署名鍵。計画noble-purring-rabbit.md → Codex MCP版+pr-review-toolkit(code-reviewer/pr-test-analyzer)3系統セカンドオピニオンを計画段階・実装後（codex review計3回、うち1回はP1修正後の再検証でfindings 0件）反映 → PR #654マージ → デプロイ前手動作業（Secret Manager作成・IAM付与・TTL policy）完了 → PR #655マージ → Deploy to Cloud Run成功 → jwksのkidがSecret Manager由来と一致することを実機確認済み
- [x] Phase 1a PR2 検証項目6: Cloud Runリビジョン再デプロイ後もクライアント登録が失効しないことの実機確認 → 済（テストクライアントをDCR登録→ベースライン`/auth`→303確認→空コミットpushで再デプロイ→リビジョン`mcp-00011-vkw`→`mcp-00012-fb5`切替を`gcloud run revisions list`で確認→同一client_idで`/auth`→303を再確認。PR2の存在意義そのものを実証。**テストクライアントの後片付け未完了**: `registrationManagement`feature未有効化のためDELETE /reg/{client_id}が404、Firestore直接削除も403で失敗。実害は極小（無認証DCRの既知リスクの範囲内、上記監視項目参照）だが要因未調査のまま残存）
- [x] Phase 1以降 着手前調査: MCPアクセストークンがFirebase UIDのみ保持し、ユーザー本人としてservices/apiを呼ぶ手段が存在しないことが判明（Phase 2着手前のブロッカー）。plan modeで対処方針を決裁者確認（① refresh token永続化方式を採用 ② 読み取り専用ツール先行 ③ super admin対策はv1見送り・残存リスク記録 ④ get_quizは正解・解説含む全情報を返す）。計画ファイル `/Users/yyyhhh/.claude/plans/linear-zooming-conway.md`、grip HTMLでレビュー済み
- [x] Step 0スパイク: Firebaseリフレッシュトークンをsecuretoken.googleapis.comで交換した後のIDトークンが`firebase.sign_in_provider === "google.com"`を保持し続けるかを実機検証 → PASS（実Googleアカウント`system@279279.net`でサインイン→ネットワーク応答からrefreshToken捕捉→curlで交換→デコードしたIDトークンで`sign_in_provider: "google.com"`, `email_verified: true`を確認。PR A設計の前提が成立）
- [x] Phase 1b-1 (PR A): Firebaseリフレッシュトークンの暗号化永続化（AES-GCM、鍵バージョン管理、Firestoreストア、トークン交換クライアント）。計画linear-zooming-conway.md参照 → 済（PR #660、テスト107件PASS/5skip、lint/type-check/build全PASS。デプロイ前手動作業: Secret Manager `mcp-credential-encryption-key` 作成 + Cloud Run既定compute SAへ`secretAccessor`付与済み〔`mcp-oauth-signing-key`と同型〕。codex review計6回（`--strict-config`含む）+ pr-review-toolkit正式プラグイン3系統×2ラウンド〔当初general-purpose代替→後半で実プラグインエージェントに切替、model:sonnet明示〕で収斂。修正内容: 同一uid同時exchange競合(P2)/応答未検証によるundefined成功扱い/失効判定の粒度誤り(revoked vs 設定不備)/Firestore書き込みブロッキング(P1)/タイマークリア漏れ(P2)/exchange成功後のstore.save失敗が無防備(CRITICAL)/復号失敗が無防備。credential-service.tsは本PR時点で未配線、Phase 2aで実際に呼び出される。マージ→デプロイ成功（`deploy-mcp`含む全job success）→**デプロイ後実機確認も完了**（2026-08-23、決裁者のブラウザで`_session` Cookie削除→完全新規Googleサインイン実行→`POST /interaction/.../firebase-callback`の0.4秒後に`mcp_user_credentials/{uid}`ドキュメントが作成されたことをFirestore REST APIで確認、`encryptedRefreshToken`は暗号化済みblobで平文露出なし。当初1-2回目の`/mcp` reconnectはPhase 1a PR2のセッション永続化によりGoogleサインインがスキップされ`firebase-callback`が呼ばれなかった＝ブラウザCookie削除が必須と判明）
- [ ] Phase 2a (PR B): 読み取り専用quizツール3種（list_courses/list_lessons/get_quiz） + LMS APIクライアント + 監査ログ。PR A完了後に着手

## 🔄 中断点（in-flight）
なし（PR Aは完全マージ・デプロイ・実機確認まで完了。次の作業単位はPhase 2a (PR B) の新規着手）

## Phase 0完了の経緯（本セッション、2026-08-21）
実クライアント接続で当初の想定になかった不具合が2件連続発覚し、いずれも修正・実機再検証済み。

1. **PR #638**: `invalid_target: resource indicator is missing, or unknown`。原因は `oidc-provider` の `resourceIndicators.getResourceServerInfo` 未実装（既定は常にエラーを投げるスタブ）。既存テストは `resource` パラメータを送らないフローしか検証しておらず未検出だった
2. **PR #639**: PR #638適用後、今度は `access_denied`（"no scope was granted"）。原因は実クライアントが `scope` パラメータを一切送らない（`resource`のみ）ため、oidc-providerの missing-scope 判定が発火せず consent 後も grant に何も追加されない挙動。`getResourceServerInfo` 内で `resource` 指定時に `scope` 未指定なら `"openid"` を補うよう修正

いずれも fix適用前RED→適用後GREENの独立再実行証拠を確認済み。最終的にPlaywright MCPでdevInteractionsのダミーログイン〜consentを実施し、`ping`ツール呼び出しで`pong`応答を実機確認して完了。

**既知の残存制約（Phase 1で解消予定、恒久登録はしないこと）**: `oidc-provider`はインメモリadapter（`services/mcp/src/oidc.ts`コメント参照）のため、Cloud Runの再デプロイ・インスタンス入れ替わりでDCR登録済みクライアントが失効する。本セッションでも2回再デプロイ後に`claude mcp remove`→`claude mcp add`での再登録が必要だった。Firestore等永続adapterへの置き換えまでは組織カスタムコネクタとしての本番配布は行わないこと。

## Phase 1a PR1完了の経緯（本セッション、2026-08-22）
決裁者承認の3案（(a)PR順序入替/(b)同時デプロイ/(c)データ消去手順追加）のうち(a)を選択、計画ファイルを再改訂した上でPR1（devInteractions→実Firebaseサインイン）を実装。

- codex review 1巡目（実装直後）: 0件
- CLAUDE.md大規模PR基準に従い`pr-review-toolkit`3系統（code-reviewer/silent-failure-hunter/pr-test-analyzer、sonnet固定・read-only）を並列起動。2系統が独立に同一CRITICAL指摘（`deploy-mcp`でNODE_ENV=production未設定 → 未捕捉エラーで`--allow-unauthenticated`な公開エンドポイントにstack traceが漏洩、`node_modules/finalhandler`/`express`の実ソースで検証済み）を検出、code-reviewerは`<script>`コンテキストのエスケープ漏れ（JSON.stringifyの`</script>`ブレークアウト）も追加指摘
- 全指摘を修正: `NODE_ENV=production`追加、app.ts末尾に4引数エラーハンドラ追加（多層防御）、`firebase.ts`にログ追加（transient/permanent分類つき）、`views.ts`に`toScriptJson`ヘルパー追加、回帰テスト3件追加（27件PASS）
- codex review 2巡目（修正反映後）: 1件（P1、Firebase Authorized domains未設定。コード修正不可の手動デプロイ前作業、計画ファイルに既に明記済み）
- PR #641作成 → CI全項目PASS → 決裁者承認 → squashマージ

## 🔔 監視中
- PR #620（`QUIZ_REQUIRE_ACTIVE_SESSION=true`本番切替のロールバック弁、2026-08-20作成）は観察期間を置いて維持する方針（2026-08-21、決裁者確認）。`/quizzes/:quizId/attempts`の409(`session_required`/`session_time_exceeded`)発生率異常、または正当な受講者からの問い合わせが確認されない限りmergeしない。観察期間終了の目安なし
- **Phase 1a PR1マージ後、Cloud Run自動デプロイが進行中**（`Deploy to Cloud Run`ワークフロー、本セッション内で完了確認予定）。devInteractionsは本番で無効化されるが、**Firebase Console → Authentication → Authorized domainsに`mcp-3zcica5euq-an.a.run.app`を追加するまでは実Googleサインインが`auth/unauthorized-domain`で失敗する**（コード外の手動作業、次セッションの即着手候補）
- **組織カスタムコネクタとしての恒久登録は上記手動作業+実機確認完了までまだ行わないこと**（Phase 1a PR2=Firestore永続化がまだ未着手のため、Cloud Run再デプロイで引き続きDCR登録クライアントが失効する制約が残っている）
- **Phase 1a PR2着手時のセカンドオピニオン（Codex MCP版 + pr-review-toolkit:code-reviewer、2026-08-22）で判明: 無認証DCR（`initialAccessToken:false`）× Client永続化（TTL対象外）で、Firestore移行後は攻撃者の分散IP登録によるClient文書の恒久的増加が理論上可能**（現行インメモリはLRU上限1000件で自己制限されるが、永続化でこの歯止めが消える）。旧計画で「DCR濫用対策の本実装はPhase 1bへ先送り、PR1で最低限のレート制限のみ前倒し」と決裁者確認済みのため、PR2では対応しない（decision-maker確認済み、2026-08-22）。**Phase 1b着手時に、Client登録数の上限・監視/アラート・削除手順のいずれかの実装を再検討すること**
- **Phase 1a PR2デプロイ前に必須の手動作業 → 完了（2026-08-22、decision-makerとターミナルで実施）**:
  1. Secret Manager に `mcp-oauth-signing-key`（jwks + cookie署名鍵のJSON、RSA 2048bit/RS256）を作成し、Cloud Runランタイムの既定compute SA（`1034821634012-compute@developer.gserviceaccount.com`）に `roles/secretmanager.secretAccessor`（当該シークレット限定）を付与 → 済（`gcloud secrets add-iam-policy-binding`で確認済み）
  2. `gcloud firestore fields ttls update expiresAt --collection-group=mcp_oauth_store --enable-ttl` → 済（`ttlConfig.state: ACTIVE` を確認）
  3. Firestore書き込み権限 → 確認の結果、既定compute SAは`roles/editor`を保有しておりFirestore読み書きを含むため追加付与不要と判明
  - PR2デプロイ → 済（PR #655マージのpush trigger経由で`Deploy to Cloud Run`ワークフロー実行、`Deploy MCP`job含め全ステップ成功、2026-08-22）
  - デプロイ後実機検証（計画`noble-purring-rabbit.md`検証項目5）→ 済。`curl https://mcp-3zcica5euq-an.a.run.app/jwks`の`kid`(`bc85324d-c613-40e2-ba36-51592ea3d98c`)がSecret Manager登録値と完全一致することを確認
  - 検証項目6（Cloud Runリビジョン再デプロイ後もクライアント登録が失効しないこと）→ 済。詳細は上記tasksチェックリスト参照
  - **残作業**: テストクライアント（`client_id: RZro_nWxJk7aYVHH81RfxrC6Grs3kSIcYdrcclL6dee`）が本番`mcp_oauth_store`に残存（`registrationManagement`feature未有効化のためDELETE /reg/{client_id}が404、Firestore直接削除も403で失敗、原因未調査）。実害は極小と判断し打ち切ったが、Phase 1b着手時に削除手段を再検討すること。**加えて2026-08-22の実機確認で新規に判明**: 今回の`ping`確認用に登録したテストクライアント（DCRで発行、client_id未記録）も同様に本番`mcp_oauth_store`に残存している見込み。同じ削除手段未確立の制約に該当するため、Phase 1b着手時にまとめて削除手段を検討すること
- **⚠️ AI運用ミス記録（2026-08-22）**: 検証項目6の空コミットを`main`へ直接pushしてしまった（`~/.claude/CLAUDE.md` 4原則§4違反、コミット`83cf195`）。コード変更を伴わない空コミットのため実害はないが、本来はfeatureブランチ+PR経由すべきだった。今後デプロイトリガー目的の運用操作を行う際はブランチ運用方針を事前に確認すること
- **PR #660（Phase 1b-1）レビューで判明したCloud Run実行環境依存リスク（decision-maker判断待ち、2026-08-23）**: `router.ts`の`persistRefreshTokenBestEffort`はサインイン応答を即座に返すため、リフレッシュトークンのFirestore書き込みはHTTPレスポンス送信後もバックグラウンドで完了する設計（`persistTimeoutMs`既定3000msで応答自体はブロックしない）。しかし現行の`.github/workflows/deploy.yml`の`deploy-mcp` jobには`--no-cpu-throttling`/`--cpu-boost`/`--min-instances`のいずれも設定がなく、Cloud Runの既定動作（レスポンス送信後にCPUが絞られる）下ではバックグラウンド書き込みが完了前に中断されうる（silent-failure-hunterセカンドオピニオンHIGH指摘）。対応は「`--no-cpu-throttling`等の恒常的インフラコスト増」or「書き込みをブロッキングに戻しP1問題を再導入」のいずれかのトレードオフで、AI側のコード修正では解決しない意思決定事項（4原則§1）。Phase 2aで`credential-service.ts`が実配線され実害が顕在化しうる前に、decision-makerの判断を仰ぐこと
- **PR #660で見送った低優先度テストギャップ**（実害なしと判断・対応不要、参考記録のみ）: `persistTimeoutMs`のちょうど境界値テスト（fake timers切替が必要で費用対効果が低いと判断）／`credential-service.ts`の`store.delete()`失敗パステスト／`getCredentialKeysFromSecretManager`のSecret Manager応答Buffer-vs-string分岐テスト（既存`signing-keys.ts`と共有する既存ギャップで本PRによる新規リグレッションではない、と担当エージェント指摘）
- **同意画面(`/confirm`)でのSessionNotFound(500)を実機で新規観測（2026-08-23、decision-maker確認済み・監視のみで対応不要と判断）**: PR A実機確認中、同一interactionへ`/interaction/:uid/confirm`が2回POSTされ2回目が`SessionNotFound`で500になる事象を1回観測（ログ: `10:11:56.125` 1回目200 → `10:11:56.615` 2回目500）。最終的に`/token`は200で発行されサインイン自体は成功。この`/confirm`ハンドラはPR Aのスコープ外（Phase 1a PR2以前から存在する既存の同意画面処理）で、二重送信の原因（consent画面側JSの二重fetch疑い、未調査）は未特定。発生1回のみでtriage基準（実害・再現性）未達のためIssue化は見送り、次回同一事象が発生した場合にIssue化を検討
