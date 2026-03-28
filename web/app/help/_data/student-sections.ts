import type { HelpSection } from "./help-sections";

export const studentSections: HelpSection[] = [
  {
    id: "getting-started",
    title: "はじめに",
    roles: ["student"],
    keywords: ["ログイン", "開始", "Google", "アカウント", "始め方"],
    description: "LMS 279へのログイン方法と基本的な使い方を説明します。",
    screenshots: [
      {
        src: "/help/screenshots/login.png",
        alt: "ログインページ",
        caption: "Googleアカウントでログインします",
      },
    ],
    steps: [
      {
        title: "LMS 279にアクセスする",
        detail: "ブラウザでLMS 279のURLを開きます。",
      },
      {
        title: "「Googleでログイン」をクリック",
        detail: "Googleアカウントを使ってログインします。",
      },
      {
        title: "テナントを選択",
        detail:
          "複数の組織に所属している場合は、利用する組織を選択します。",
      },
    ],
    callouts: [
      {
        variant: "info",
        title: "初回ログイン",
        content:
          "管理者が許可メールリストにあなたのメールアドレスを登録している必要があります。",
      },
    ],
  },
  {
    id: "student-courses",
    title: "講座を受講する",
    roles: ["student"],
    keywords: ["講座", "コース", "受講", "一覧", "進捗"],
    description: "受講可能な講座の確認方法と受講の始め方を説明します。",
    screenshots: [
      {
        src: "/help/screenshots/student-course-list.png",
        alt: "講座一覧ページ",
        caption: "受講可能な講座が一覧表示されます",
      },
      {
        src: "/help/screenshots/student-course-detail.png",
        alt: "コース詳細ページ",
        caption: "コースに含まれるレッスンの一覧が表示されます",
      },
    ],
    steps: [
      {
        title: "講座一覧を開く",
        detail: "ログイン後、「講座一覧」ページで受講可能な講座を確認します。",
      },
      {
        title: "講座を選択",
        detail:
          "受講したい講座をクリックして詳細を確認します。進捗状況がバッジで表示されます（完了・進行中・未開始）。",
      },
      {
        title: "レッスンを開始",
        detail: "レッスン一覧から受講したいレッスンを選択して学習を始めます。",
      },
    ],
    callouts: [
      {
        variant: "info",
        title: "進捗表示",
        content:
          "各講座の進捗率がパーセントとプログレスバーで表示されます。全レッスン完了で「完了」バッジが付きます。",
      },
    ],
  },
  {
    id: "student-video",
    title: "動画を視聴する",
    roles: ["student"],
    keywords: [
      "動画",
      "ビデオ",
      "視聴",
      "再生",
      "倍速",
      "出席",
      "セッション",
      "タイマー",
    ],
    description:
      "動画プレイヤーの操作方法、出席管理（セッション）のルールを説明します。",
    screenshots: [
      {
        src: "/help/screenshots/student-video-player.png",
        alt: "動画プレイヤー",
        caption: "カスタム動画プレイヤーで学習動画を視聴します",
      },
    ],
    steps: [
      {
        title: "レッスンページを開く",
        detail: "コース詳細からレッスンを選択します。",
      },
      {
        title: "動画を再生する",
        detail:
          "再生ボタンをクリックして動画を視聴します。再生を開始すると「入室」として記録されます。",
      },
      {
        title: "セッションタイマーを確認する",
        detail:
          "画面にセッション残り時間が表示されます。入室から2時間が制限時間です。",
      },
      {
        title: "動画を最後まで視聴する",
        detail:
          "動画を最後まで視聴すると、テストのセクションが解放されます。",
      },
    ],
    callouts: [
      {
        variant: "warning",
        title: "倍速再生について",
        content:
          "倍速再生は禁止されています。倍速再生が検出された場合、自動的に通常速度に戻されます。",
      },
      {
        variant: "warning",
        title: "セッション制限時間",
        content:
          "入室から2時間が制限時間です。残り30分で黄色、残り10分で赤色の警告が表示されます。時間を過ぎると強制退室となります。",
      },
      {
        variant: "info",
        title: "一時停止について",
        content:
          "15分以上一時停止したままにすると、強制退室となります。休憩後は改めてレッスンを開いてください。",
      },
      {
        variant: "info",
        title: "視聴記録",
        content:
          "視聴の進捗は自動的に記録されます。途中で中断しても、次回アクセス時に続きから視聴できます。",
      },
    ],
  },
  {
    id: "student-quiz",
    title: "テストを受ける",
    roles: ["student"],
    keywords: [
      "テスト",
      "問題",
      "採点",
      "結果",
      "合格",
      "受験",
      "制限時間",
    ],
    description: "テストの受験方法と結果の確認方法を説明します。",
    screenshots: [],
    steps: [
      {
        title: "動画を視聴完了する",
        detail:
          "テストは動画を最後まで視聴した後にアクセスできるようになります。",
      },
      {
        title: "「テストを開始」をクリック",
        detail:
          "テスト情報（問題数、合格基準など）を確認し、「テストを開始」ボタンをクリックします。",
      },
      {
        title: "問題に回答する",
        detail:
          "各問題の選択肢から回答を選びます。単一選択の問題と複数選択の問題があります。",
      },
      {
        title: "提出して結果を確認",
        detail:
          "「提出」ボタンをクリックすると、自動採点された結果が表示されます。正誤・得点・解説を確認できます。",
      },
    ],
    callouts: [
      {
        variant: "info",
        title: "受験回数",
        content:
          "テストは何度でも受け直すことができます。最高スコアが記録されます。",
      },
      {
        variant: "info",
        title: "制限時間",
        content:
          "制限時間が設定されているテストでは、画面にカウントダウンタイマーが表示されます。時間切れになると自動的に提出されます。",
      },
      {
        variant: "success",
        title: "合格基準",
        content:
          "テストごとに合格基準（例: 70%）が設定されています。合格するとレッスン完了として記録されます。",
      },
    ],
  },
  {
    id: "student-faq",
    title: "よくある質問",
    roles: ["student"],
    keywords: ["FAQ", "質問", "トラブル", "困った"],
    description: "受講者向けのよくある質問と回答をまとめています。",
    screenshots: [],
    steps: [],
    callouts: [],
    faqs: [
      {
        question: "ログインできません",
        answer:
          "管理者が許可メールリストにあなたのメールアドレスを追加している必要があります。管理者に確認してください。",
      },
      {
        question: "動画が再生されません",
        answer:
          "ブラウザを最新版に更新してください。Chrome、Firefox、Safari、Edgeの最新版を推奨しています。",
      },
      {
        question: "テストが表示されません",
        answer:
          "テストは動画を最後まで視聴してから利用できるようになります。動画を最後まで視聴してください。",
      },
      {
        question: "進捗がリセットされました",
        answer:
          "進捗データはアカウントに紐づいています。同じGoogleアカウントでログインしているか確認してください。",
      },
      {
        question: "セッション制限時間を過ぎてしまいました",
        answer:
          "制限時間（2時間）を過ぎると強制退室となります。改めてレッスンを開いて再度受講してください。視聴済みの進捗は保持されています。",
      },
      {
        question: "一時停止したまま離席してしまいました",
        answer:
          "15分以上一時停止すると強制退室となります。レッスンを開き直して受講を再開してください。",
      },
      {
        question: "テストは何回受けられますか？",
        answer:
          "テストは何度でも受け直すことができます。不合格でも繰り返し挑戦できます。",
      },
    ],
  },
];
