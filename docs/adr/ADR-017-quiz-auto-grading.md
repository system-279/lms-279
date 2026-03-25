# ADR-017: テスト自動採点

## ステータス
承認済み

## コンテキスト
テストの採点方式

## 決定
サーバーサイドで自動採点。正解はsubmit後まで非公開

## 根拠
クライアントに正解データを送信しないことで不正防止。GET /quizzes/:idはoptions.isCorrectを除外して返却

## 影響
quiz_attemptsのsubmit時にサーバーで採点実行。score, isPassedを算出してレスポンス
