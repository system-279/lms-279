# ADR-023: Classroom/Forms API不使用

## ステータス
承認済み

## コンテキスト
Google Classroom APIやGoogle Forms APIとの連携検討

## 決定
全コンテンツ（講座・レッスン・クイズ）は手動管理のみ。外部API連携なし

## 根拠
ADR-004（OAuth審査見送り）と同様の理由。LMS内で完結するコンテンツ管理が初期段階では最適

## 影響
管理画面でCRUD操作を提供。将来的なAPI連携の余地は残す（データモデルに拡張フィールド不要）
