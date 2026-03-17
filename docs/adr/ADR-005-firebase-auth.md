# ADR-005: Firebase Authentication採用

## ステータス
承認済み

## コンテキスト
ユーザー認証方式の選定

## 決定
Firebase Authenticationを採用。Googleソーシャルログインを提供

## 根拠
GCPエコシステムとの統合が容易。管理コンソール付属。JWT検証がサーバーサイドで容易。開発時はAUTH_MODE=devでヘッダ疑似認証が可能

## 影響
API側はFirebase Admin SDKでトークン検証。Web側はFirebase SDKでAuthContext管理
