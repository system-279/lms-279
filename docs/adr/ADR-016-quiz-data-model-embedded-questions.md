# ADR-016: クイズデータモデル（問題埋め込み）

## ステータス
承認済み

## コンテキスト
クイズの問題データの格納方式

## 決定
問題をquizzesドキュメントのquestionsフィールドに埋め込み（サブコレクション不使用）。上限50問

## 根拠
1回のドキュメント読み取りで全問題を取得可能。Firestoreのドキュメントサイズ上限（1MB）は50問程度では十分。サブコレクション方式はN+1クエリが発生

## 影響
questions配列に{id, text, type(single/multi), options[{id, text, isCorrect}], points, explanation}を格納
