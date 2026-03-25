export type HelpRole = "student" | "admin" | "super";

export type HelpStep = {
  title: string;
  detail?: string;
};

export type HelpScreenshot = {
  src: string;
  alt: string;
  caption: string;
};

export type HelpCallout = {
  variant: "info" | "warning" | "success";
  title: string;
  content: string;
};

export type HelpFaq = {
  question: string;
  answer: string;
};

export type HelpSection = {
  id: string;
  title: string;
  roles: HelpRole[];
  keywords: string[];
  description: string;
  screenshots: HelpScreenshot[];
  steps: HelpStep[];
  callouts: HelpCallout[];
  faqs?: HelpFaq[];
};

export const roleLabels: Record<HelpRole, string> = {
  student: "受講者",
  admin: "管理者",
  super: "スーパー管理者",
};

export const helpSections: HelpSection[] = [
  {
    id: "getting-started",
    title: "はじめに",
    roles: ["student", "admin", "super"],
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
        detail: "受講したい講座をクリックして詳細を確認します。",
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
        content: "各講座の進捗状況がバッジで表示されます。",
      },
    ],
  },
  {
    id: "student-video",
    title: "動画を視聴する",
    roles: ["student"],
    keywords: ["動画", "ビデオ", "視聴", "再生", "倍速"],
    description: "動画プレイヤーの操作方法と視聴のルールを説明します。",
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
        detail: "再生ボタンをクリックして動画を視聴します。",
      },
      {
        title: "動画を最後まで視聴する",
        detail: "動画を最後まで視聴すると、テストのセクションが解放されます。",
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
    keywords: ["テスト", "問題", "採点", "結果", "合格"],
    description: "テストの受験方法と結果の確認方法を説明します。",
    screenshots: [
      {
        src: "/help/screenshots/student-quiz-taking.png",
        alt: "テスト受験画面",
        caption: "テストの問題に回答します",
      },
      {
        src: "/help/screenshots/student-quiz-results.png",
        alt: "テスト結果画面",
        caption: "テストの採点結果が表示されます",
      },
    ],
    steps: [
      {
        title: "動画を視聴完了する",
        detail:
          "テストは動画を最後まで視聴した後にアクセスできるようになります。",
      },
      {
        title: "テストに回答する",
        detail: "各問題に回答し、「提出」ボタンをクリックします。",
      },
      {
        title: "結果を確認する",
        detail:
          "提出後、自動採点された結果が表示されます。正誤と得点を確認できます。",
      },
    ],
    callouts: [
      {
        variant: "info",
        title: "再受験",
        content: "テストは何度でも受け直すことができます。",
      },
    ],
  },
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
        detail: "ステータスを「公開」に変更すると、受講者がアクセスできるようになります。",
      },
    ],
    callouts: [
      {
        variant: "info",
        title: "ステータスフィルタ",
        content: "「すべて」「下書き」「公開」でフィルタリングできます。",
      },
    ],
  },
  {
    id: "admin-lessons",
    title: "レッスンを編集する",
    roles: ["admin"],
    keywords: ["レッスン", "動画", "アップロード", "テスト", "編集"],
    description: "レッスンの動画アップロードとテスト設定方法を説明します。",
    screenshots: [
      {
        src: "/help/screenshots/admin-lesson-editor.png",
        alt: "レッスン編集ページ",
        caption: "動画とテストを設定するレッスン編集画面です",
      },
    ],
    steps: [
      {
        title: "講座詳細からレッスンを選択",
        detail: "講座管理ページから講座を選び、レッスンを選択します。",
      },
      {
        title: "動画をアップロード",
        detail: "動画ファイルを選択してアップロードします。",
      },
      {
        title: "テストを設定",
        detail:
          "テスト問題を追加します。選択式・複数選択・記述式から選べます（最大50問）。",
      },
    ],
    callouts: [
      {
        variant: "warning",
        title: "動画形式",
        content: "MP4形式の動画ファイルをアップロードしてください。",
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
    keywords: ["分析", "進捗", "統計", "CSV", "エクスポート", "レポート"],
    description: "受講者の進捗データと分析ダッシュボードの使い方を説明します。",
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
        title: "進捗データを確認",
        detail: "受講者ごとの動画視聴状況やテスト結果を確認できます。",
      },
      {
        title: "CSVエクスポート",
        detail: "データをCSV形式でダウンロードしてExcel等で分析できます。",
      },
    ],
    callouts: [],
  },
  {
    id: "super-master",
    title: "マスター講座を管理する",
    roles: ["super"],
    keywords: ["マスター", "テンプレート", "講座", "作成", "スーパー管理者"],
    description:
      "マスター講座（テンプレート）の作成・編集方法を説明します。",
    screenshots: [
      {
        src: "/help/screenshots/super-master-courses.png",
        alt: "マスター講座一覧",
        caption: "マスター講座の管理画面です",
      },
      {
        src: "/help/screenshots/super-course-editor.png",
        alt: "マスター講座編集",
        caption: "マスター講座の編集画面です",
      },
    ],
    steps: [
      {
        title: "マスターコース管理を開く",
        detail: "スーパー管理者メニューから「マスターコース」を選択します。",
      },
      {
        title: "マスター講座を作成",
        detail:
          "「新規作成」ボタンからマスター講座を作成します。これがテナントに配信するテンプレートになります。",
      },
      {
        title: "レッスンと動画を設定",
        detail: "マスター講座にレッスンを追加し、動画やテストを設定します。",
      },
    ],
    callouts: [
      {
        variant: "info",
        title: "マスター講座とは",
        content:
          "マスター講座は複数のテナントに一括配信できるテンプレートです。各テナントにコピーとして配信されます。",
      },
    ],
  },
  {
    id: "super-distribute",
    title: "講座を配信する",
    roles: ["super"],
    keywords: ["配信", "テナント", "コピー", "一括", "スーパー管理者"],
    description:
      "マスター講座を各テナントに配信する方法を説明します。",
    screenshots: [
      {
        src: "/help/screenshots/super-distribute.png",
        alt: "テナント配信画面",
        caption: "マスター講座をテナントに配信する画面です",
      },
    ],
    steps: [
      {
        title: "テナント配信ページを開く",
        detail: "スーパー管理者メニューから「テナント配信」を選択します。",
      },
      {
        title: "配信するマスター講座を選択",
        detail: "配信したいマスター講座を選択します。",
      },
      {
        title: "配信先テナントを選択",
        detail: "配信先のテナントを選択して「配信」を実行します。",
      },
    ],
    callouts: [
      {
        variant: "warning",
        title: "配信の注意",
        content:
          "配信すると、テナント側にマスター講座のコピーが作成されます。配信後のテナント側の変更はマスターには反映されません。",
      },
    ],
  },
  {
    id: "faq",
    title: "よくある質問",
    roles: ["student", "admin", "super"],
    keywords: ["FAQ", "質問", "トラブル", "困った"],
    description: "よくある質問と回答をまとめています。",
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
        question: "受講者にリンクを共有するには？",
        answer:
          "管理ダッシュボードに表示される受講者用リンクをコピーして共有してください。受講者はそのリンクからログインして講座を受講できます。",
      },
    ],
  },
];
