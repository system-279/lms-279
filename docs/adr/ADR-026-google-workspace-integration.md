# ADR-026: Google Workspace連携（Drive動画インポート + Docsクイズ生成）

## ステータス
承認済み

## コンテキスト
管理者がレッスンのコンテンツを登録する際、現在はGCSパスの直接指定またはファイルアップロードが必要で、クイズは手動作成のみ。279279.netドメインのGoogle Workspaceにある動画やドキュメントを直接活用したいという要件がある。

ADR-004ではGoogle Classroom/Forms APIを「再生制御・視聴追跡が不可」として見送った。本ADRは**再生**ではなく**コンテンツのインポート元**としてGoogle Drive/Docsを利用するため、ADR-004の制約とは矛盾しない。

## 決定
以下の2機能を実装する:

1. **Google Drive動画インポート**: DriveのリンクからGCSに動画をコピーし、既存の署名付きURL再生フローで配信
2. **Google Docsクイズ自動生成**: Docsの内容をVertex AI（Gemini）で分析し、クイズ問題を自動生成

### 認証方式
- サービスアカウントのDomain-Wide Delegation（DWD）を使用
- 279279.netドメイン内に限定（外部ドメインのファイルは対象外）
- OAuthコンセント画面は不要（DWDはドメイン管理者が許可）

### 動画インポートフロー
1. 管理者がDrive URLを入力
2. サーバーがDrive APIでファイルメタデータを検証（動画ファイルか、サイズ上限内か）
3. Drive→GCSにストリームコピー（非同期、メモリバッファ不可）
4. コピー完了後は`sourceType=google_drive`、`gcsPath`に保存先を記録
5. 再生は既存のGCS署名付きURL方式（カスタムHTML5プレイヤー維持）

### クイズ生成フロー
1. 管理者がDocs URLを入力
2. サーバーがDocs APIでドキュメント内容を取得
3. Vertex AI（Gemini）にプロンプトと共に送信、構造化JSON出力で問題を生成
4. 生成結果をプレビューとして返却（この時点では保存しない）
5. 管理者がプレビュー・編集後、既存のクイズ保存APIで確定

## 根拠
- **GCSコピー方式**: Drive直接配信では署名付きURLの仕組みが使えず、倍速禁止・視聴分析等の既存機能が動作しない
- **DWD**: OAuth審査不要、ドメイン内に閉じた安全なアクセス、サーバーサイド完結
- **Gemini（Vertex AI）**: 同一GCPプロジェクト内で完結、追加の認証情報不要
- **プレビュー→保存の2段階**: AI生成結果の品質を管理者が確認・修正できる

## 影響
- `googleapis`パッケージの追加（Drive API v3, Docs API v1）
- `@google-cloud/vertexai`パッケージの追加
- `VideoSourceType`に`google_drive`を追加
- GCP管理コンソールでのDWD設定（手動、1回限り）
- Vertex AI APIの有効化とIAMロール付与
- 環境変数: `GOOGLE_WORKSPACE_ADMIN_EMAIL`, `VERTEX_AI_LOCATION`
