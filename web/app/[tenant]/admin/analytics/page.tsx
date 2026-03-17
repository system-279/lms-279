"use client";

export default function AnalyticsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">分析ダッシュボード</h1>
        <p className="text-sm text-muted-foreground mt-1">
          学習状況や動画視聴統計を確認できます。
        </p>
      </div>

      <div className="rounded-md border p-8 text-center space-y-4">
        <p className="text-lg font-medium text-muted-foreground">
          分析機能はPhase 5で本格実装予定
        </p>
        <p className="text-sm text-muted-foreground">
          以下の機能が追加される予定です。
        </p>
      </div>

      <ul className="space-y-3">
        {[
          { label: "コース別進捗", description: "受講者ごとのコース完了率・進捗状況を一覧表示" },
          { label: "ユーザー別進捗", description: "各ユーザーの学習履歴・達成状況を詳細確認" },
          { label: "動画視聴統計", description: "レッスン動画の平均視聴率・完了率・離脱ポイントを分析" },
          { label: "クイズ統計", description: "クイズの正答率・頻出誤答・難易度評価を確認" },
          {
            label: "不審視聴パターン検出",
            description: "異常な視聴速度・短時間反復再生など不正視聴の疑いがあるアクティビティを検知",
          },
        ].map((item) => (
          <li key={item.label} className="rounded-md border p-4 space-y-1">
            <p className="font-medium">{item.label}</p>
            <p className="text-sm text-muted-foreground">{item.description}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
