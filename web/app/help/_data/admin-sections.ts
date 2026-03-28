import type { HelpSection } from "./help-sections";

export const adminSections: HelpSection[] = [
  {
    id: "admin-dashboard",
    title: "管理ダッシュボード",
    roles: ["admin"],
    keywords: ["ダッシュボード", "管理", "概要", "共有リンク"],
    description: "管理ダッシュボードの見方と基本操作を説明します。",
    screenshots: [
      {
        src: "/help/screenshots/admin-dashboard.png",
        alt: "管理ダッシュボード",
        caption: "管理者向けのダッシュボード画面です",
      },
    ],
    steps: [
      {
        title: "ダッシュボードにアクセス",
        detail: "ヘッダーの「管理者向け」リンクからダッシュボードに移動します。",
      },
      {
        title: "受講者用リンクを共有",
        detail:
          "ダッシュボードに表示される受講者用リンクをコピーして、受講者に共有します。",
      },
    ],
    callouts: [
      {
        variant: "info",
        title: "ナビゲーション",
        content:
          "上部のナビゲーションから「講座管理」「受講者管理」「許可メール管理」「分析」にアクセスできます。",
      },
    ],
  },
  {
    id: "admin-courses",
    title: "講座を管理する",
    roles: ["admin"],
    keywords: ["講座", "コース", "作成", "編集", "公開", "管理"],
    description: "講座の作成・編集・公開方法を説明します。",
    screenshots: [
      {
        src: "/help/screenshots/admin-course-management.png",
        alt: "講座管理ページ",
        caption: "講座の一覧管理画面です",
      },
    ],
    steps: [
      {
        title: "講座管理ページを開く",
        detail: "ナビゲーションから「講座管理」を選択します。",
      },
      {
        title: "講座を新規作成",
        detail: "「新規作成」ボタンから講座名と説明を入力して作成します。",
      },
      {
        title: "講座を公開する",
        detail:
          "ステータスを「公開」に変更すると、受講者がアクセスできるようになります。",
      },
    ],
    callouts: [
      {
        variant: "info",
        title: "ステータス",
        content:
          "講座は「下書き」「公開中」「アーカイブ」の3つのステータスを持ちます。フィルタで絞り込みができます。",
      },
    ],
  },
  {
    id: "admin-lessons",
    title: "レッスンを編集する",
    roles: ["admin"],
    keywords: [
      "レッスン",
      "動画",
      "アップロード",
      "テスト",
      "編集",
      "Google Drive",
      "Google Docs",
      "インポート",
    ],
    description:
      "レッスンの動画登録・テスト作成方法を説明します。動画はファイルアップロードとGoogle Driveインポートに対応。テストは手動作成・AI生成・Googleドキュメントインポートが可能です。",
    screenshots: [],
    steps: [
      {
        title: "講座詳細からレッスンを選択",
        detail: "講座管理ページから講座を選び、レッスンを選択します。",
      },
      {
        title: "動画を登録する",
        detail:
          "2つの方法があります。(1) MP4ファイルを直接アップロード (2) Google DriveのURLを入力してインポート。Google Driveの場合、バックグラウンドでコピーされるため少し時間がかかります。",
      },
      {
        title: "動画設定を確認",
        detail:
          "動画の長さ、必須視聴比率（デフォルト95%）、倍速禁止（デフォルトON）を設定できます。",
      },
      {
        title: "テストを作成する",
        detail:
          "3つの方法があります。(1) 手動作成：問題と選択肢をUIで直接入力 (2) Google Docs生成：ドキュメントURLと問題数・難易度を指定してAIが自動生成 (3) Google Docsインポート：既存のテスト問題をドキュメントから取り込み（太字の選択肢が正解として判定されます）",
      },
      {
        title: "テスト設定を調整",
        detail:
          "合格基準（デフォルト70%）、受験回数（0=無制限）、制限時間、問題・選択肢のランダム化、動画完了必須などを設定できます。",
      },
    ],
    callouts: [
      {
        variant: "info",
        title: "動画形式",
        content:
          "直接アップロードはMP4形式に対応しています。Google Driveからのインポートはリンクを貼り付けるだけで自動的にコピーされます。",
      },
      {
        variant: "info",
        title: "テスト問題の形式",
        content:
          "テストは単一選択（1つだけ正解）と複数選択（複数正解あり）に対応しています。最大50問まで設定できます。",
      },
      {
        variant: "warning",
        title: "Google Docsインポートの注意",
        content:
          "Googleドキュメントからテストをインポートする場合、正解の選択肢を太字にしておいてください。太字の選択肢が正解として取り込まれます。",
      },
    ],
  },
  {
    id: "admin-users",
    title: "受講者を管理する",
    roles: ["admin"],
    keywords: ["受講者", "ユーザー", "管理", "登録", "一覧"],
    description: "受講者の確認と管理方法を説明します。",
    screenshots: [
      {
        src: "/help/screenshots/admin-user-management.png",
        alt: "受講者管理ページ",
        caption: "受講者の一覧と管理画面です",
      },
    ],
    steps: [
      {
        title: "受講者管理ページを開く",
        detail: "ナビゲーションから「受講者管理」を選択します。",
      },
      {
        title: "受講者の状況を確認",
        detail: "登録済みの受講者とその進捗状況を確認できます。",
      },
    ],
    callouts: [],
  },
  {
    id: "admin-emails",
    title: "許可メールを管理する",
    roles: ["admin"],
    keywords: ["メール", "許可", "ホワイトリスト", "登録", "アクセス制御"],
    description: "受講を許可するメールアドレスの管理方法を説明します。",
    screenshots: [
      {
        src: "/help/screenshots/admin-allowed-emails.png",
        alt: "許可メール管理ページ",
        caption: "受講を許可するメールアドレスの管理画面です",
      },
    ],
    steps: [
      {
        title: "許可メール管理ページを開く",
        detail: "ナビゲーションから「許可メール管理」を選択します。",
      },
      {
        title: "メールアドレスを追加",
        detail:
          "受講を許可するメールアドレスを入力して追加します。ここに登録されたアドレスのユーザーのみログインできます。",
      },
      {
        title: "メールアドレスを削除",
        detail: "不要になったメールアドレスを削除してアクセスを無効化します。",
      },
    ],
    callouts: [
      {
        variant: "warning",
        title: "注意",
        content:
          "メールアドレスを削除しても、既にログイン済みの受講者のデータは残ります。",
      },
    ],
  },
  {
    id: "admin-analytics",
    title: "分析を確認する",
    roles: ["admin"],
    keywords: [
      "分析",
      "進捗",
      "統計",
      "CSV",
      "エクスポート",
      "レポート",
      "出席",
      "不審",
    ],
    description:
      "受講者の進捗データ・出席記録・不審視聴パターンの分析方法を説明します。",
    screenshots: [
      {
        src: "/help/screenshots/admin-analytics.png",
        alt: "分析ダッシュボード",
        caption: "受講者の進捗と学習状況の分析画面です",
      },
    ],
    steps: [
      {
        title: "分析ページを開く",
        detail: "ナビゲーションから「分析」を選択します。",
      },
      {
        title: "コース進捗タブ",
        detail:
          "コース別の受講者進捗一覧を確認できます。完了レッスン数、進捗率、完了者数が表示されます。",
      },
      {
        title: "受講者進捗タブ",
        detail:
          "受講者別のコース進捗詳細を確認できます。各レッスンの動画完了・テスト合格状況が一覧表示されます。",
      },
      {
        title: "不審視聴パターンタブ",
        detail:
          "不審な視聴行動が検出された受講者を確認できます。過度なシーク、バックグラウンド再生、倍速違反などが記録されます。",
      },
      {
        title: "出席管理タブ",
        detail:
          "レッスン別の入退室記録を確認できます。入室時刻、退室時刻、退室理由、最長一時停止時間が表示されます。CSVエクスポートも可能です。",
      },
    ],
    callouts: [
      {
        variant: "info",
        title: "CSVエクスポート",
        content:
          "各タブのデータをCSV形式でダウンロードしてExcel等で分析できます。",
      },
    ],
  },
  {
    id: "admin-faq",
    title: "よくある質問",
    roles: ["admin"],
    keywords: ["FAQ", "質問", "トラブル", "困った"],
    description: "管理者向けのよくある質問と回答をまとめています。",
    screenshots: [],
    steps: [],
    callouts: [],
    faqs: [
      {
        question: "受講者にリンクを共有するには？",
        answer:
          "管理ダッシュボードに表示される受講者用リンクをコピーして共有してください。受講者はそのリンクからログインして講座を受講できます。",
      },
      {
        question: "Google Driveの動画がインポートされません",
        answer:
          "Google DriveのURLが正しいか確認してください。動画ファイルへの共有設定が必要な場合があります。インポートはバックグラウンドで処理されるため、ステータスが「完了」になるまでお待ちください。",
      },
      {
        question: "Googleドキュメントからテストをインポートする形式は？",
        answer:
          "問題番号（1. / 第1問 / 問1 など）で問題を区切り、選択肢はa) / A. / ア) などで記述してください。正解の選択肢は太字にしてください。",
      },
      {
        question: "テストの受験回数を制限できますか？",
        answer:
          "テスト設定で「最大受験回数」を変更できます。0に設定すると無制限（何度でも受験可能）になります。",
      },
      {
        question: "講座を削除できません",
        answer:
          "公開中の講座は直接削除できません。先にアーカイブに変更してから削除してください。",
      },
    ],
  },
];
