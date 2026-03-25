import Link from "next/link";
import {
  Monitor,
  Users,
  GraduationCap,
  ArrowRight,
  Server,
  Database,
  Cloud,
  Video,
  FileQuestion,
  BarChart3,
  Shield,
  BookOpen,
  Settings,
  Send,
  ClipboardList,
  Mail,
  Play,
} from "lucide-react";

// ─── 型定義 ─────────────────────────────────

type Screen = {
  name: string;
  url: string;
  description: string;
  icon: React.ReactNode;
};

type ScreenSection = {
  title: string;
  color: string;
  bgColor: string;
  borderColor: string;
  icon: React.ReactNode;
  screens: Screen[];
};

type FlowStep = {
  step: number;
  title: string;
  role: string;
  description: string;
  details?: string[];
};

type Feature = {
  title: string;
  description: string;
  details: string[];
  reference?: string;
};

// ─── データ ─────────────────────────────────

const screenSections: ScreenSection[] = [
  {
    title: "スーパー管理",
    color: "text-violet-700",
    bgColor: "bg-violet-50",
    borderColor: "border-violet-200",
    icon: <Shield className="size-5" />,
    screens: [
      {
        name: "マスターコース管理",
        url: "/super/master/courses",
        description: "コース・レッスン・動画・テストの管理",
        icon: <BookOpen className="size-4" />,
      },
      {
        name: "マスターコース詳細",
        url: "/super/master/courses/{id}",
        description: "動画・テスト設定、プレビュー",
        icon: <Settings className="size-4" />,
      },
      {
        name: "テナント配信",
        url: "/super/distribute",
        description: "マスターコースをテナントに配信・再配信",
        icon: <Send className="size-4" />,
      },
      {
        name: "設定",
        url: "/super/settings",
        description: "テナント管理",
        icon: <Settings className="size-4" />,
      },
    ],
  },
  {
    title: "テナント管理",
    color: "text-blue-700",
    bgColor: "bg-blue-50",
    borderColor: "border-blue-200",
    icon: <Users className="size-5" />,
    screens: [
      {
        name: "ダッシュボード",
        url: "/{tenant}/admin",
        description: "テナントの概要",
        icon: <BarChart3 className="size-4" />,
      },
      {
        name: "講座管理",
        url: "/{tenant}/admin/courses",
        description: "コースの公開/アーカイブ/削除",
        icon: <BookOpen className="size-4" />,
      },
      {
        name: "レッスン管理",
        url: "/{tenant}/admin/courses/{id}/lessons",
        description: "レッスン一覧",
        icon: <ClipboardList className="size-4" />,
      },
      {
        name: "レッスン詳細",
        url: "/{tenant}/admin/courses/{id}/lessons/{id}",
        description: "動画・テスト管理",
        icon: <Play className="size-4" />,
      },
      {
        name: "受講者管理",
        url: "/{tenant}/admin/users",
        description: "受講者の登録・管理",
        icon: <Users className="size-4" />,
      },
      {
        name: "許可メール管理",
        url: "/{tenant}/admin/allowed-emails",
        description: "ログイン許可メール",
        icon: <Mail className="size-4" />,
      },
      {
        name: "分析",
        url: "/{tenant}/admin/analytics",
        description: "進捗・視聴データ分析",
        icon: <BarChart3 className="size-4" />,
      },
    ],
  },
  {
    title: "受講者",
    color: "text-emerald-700",
    bgColor: "bg-emerald-50",
    borderColor: "border-emerald-200",
    icon: <GraduationCap className="size-5" />,
    screens: [
      {
        name: "コース一覧",
        url: "/{tenant}/student/courses",
        description: "受講可能コース",
        icon: <BookOpen className="size-4" />,
      },
      {
        name: "コース詳細",
        url: "/{tenant}/student/courses/{id}",
        description: "レッスン一覧・進捗",
        icon: <ClipboardList className="size-4" />,
      },
      {
        name: "レッスン受講",
        url: "/{tenant}/student/courses/{id}/lessons/{id}",
        description: "動画視聴・テスト受験",
        icon: <Play className="size-4" />,
      },
    ],
  },
];

const flowSteps: FlowStep[] = [
  {
    step: 1,
    title: "マスターコース作成",
    role: "スーパー管理",
    description: "コース名・説明を設定",
  },
  {
    step: 2,
    title: "レッスン追加",
    role: "スーパー管理",
    description: "レッスンタイトル・順序を設定",
  },
  {
    step: 3,
    title: "動画登録",
    role: "スーパー管理",
    description: "ファイルアップロードまたはGoogle Driveインポート",
    details: ["ファイルアップロード（GCS）", "Google Driveからインポート"],
  },
  {
    step: 4,
    title: "テスト作成",
    role: "スーパー管理",
    description: "手動作成、Google Docs生成、またはインポート",
    details: [
      "手動作成（問題・選択肢を入力）",
      "Google Docsから生成（AIが問題を自動生成）",
      "Google Docsからインポート（既存テストを取り込み）",
    ],
  },
  {
    step: 5,
    title: "コース公開",
    role: "スーパー管理",
    description: "ステータスを draft → published に変更",
  },
  {
    step: 6,
    title: "テナント配信",
    role: "スーパー管理",
    description: "マスターコースをテナントに深コピー",
    details: [
      "初回配信: コース・レッスン・動画・テストを深コピー",
      "再配信: 既存を削除して最新を再コピー",
    ],
  },
  {
    step: 7,
    title: "テナント側コース公開",
    role: "テナント管理",
    description: "配信されたコースを公開",
  },
  {
    step: 8,
    title: "受講者がコースを受講",
    role: "受講者",
    description: "動画視聴 → テスト受験 → 進捗記録",
  },
];

const features: Feature[] = [
  {
    title: "テスト取り込み機能",
    description:
      "Google Docsの「テスト」タブから既存テストをインポート。Geminiをパーサーとして使用し、問題の創作を防止。",
    details: [
      "太字=正解として自動判定",
      "太字以外の書式も正解ヒントとして検出",
      "正解不明の場合はユーザーが手動設定",
    ],
    reference: "Issue #60",
  },
  {
    title: "コース配信",
    description:
      "マスターコースの深コピーでテナントに配信。再配信オプションで最新コンテンツを反映。",
    details: [
      "レッスン・動画・テスト全てを深コピー",
      "GCS動画パスは共有（コピーしない）",
      "再配信: 既存データ削除→最新を再コピー",
    ],
    reference: "ADR-024",
  },
  {
    title: "動画プレイヤー",
    description:
      "カスタムHTML5 Video API。倍速禁止をサーバーサイドで強制。署名付きURL（2時間有効）で配信。",
    details: [
      "倍速再生禁止（違反はサーバーで記録）",
      "5秒間隔で視聴イベントをバッチ送信",
      "不審行動をサーバーサイドで検出",
    ],
    reference: "ADR-012〜015",
  },
  {
    title: "出席管理",
    description:
      "レッスン受講時の入退室打刻。15分一時停止で自動退室、2時間制限で強制退室。",
    details: [
      "lesson_sessionsで入退室を管理",
      "15分間操作なしで一時停止→自動退室",
      "2時間連続で強制退室",
    ],
    reference: "ADR-027",
  },
];

// ─── ページ ─────────────────────────────────

export default function InternalPortalPage() {
  return (
    <>
      {/* Header */}
      <header className="sticky top-0 z-40 border-b bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4">
          <span className="font-semibold">LMS 279 内部ポータル</span>
          <Link
            href="/"
            className="text-sm text-muted-foreground hover:text-foreground transition"
          >
            LMS に戻る
          </Link>
        </div>
      </header>

      {/* Hero */}
      <section className="border-b bg-card py-10">
        <div className="mx-auto max-w-7xl px-4">
          <h1 className="text-3xl font-bold">LMS 279 内部ポータル</h1>
          <p className="mt-2 text-muted-foreground">
            システム全体像・画面一覧・運用フロー・主要機能のガイド
          </p>
        </div>
      </section>

      {/* 目次 */}
      <nav className="border-b bg-card/50 py-4">
        <div className="mx-auto max-w-7xl px-4">
          <ul className="flex flex-wrap gap-4 text-sm">
            <li>
              <a
                href="#architecture"
                className="text-primary hover:underline"
              >
                アーキテクチャ
              </a>
            </li>
            <li>
              <a href="#screens" className="text-primary hover:underline">
                画面一覧
              </a>
            </li>
            <li>
              <a href="#flow" className="text-primary hover:underline">
                運用フロー
              </a>
            </li>
            <li>
              <a href="#features" className="text-primary hover:underline">
                主要機能
              </a>
            </li>
            <li>
              <a href="#env" className="text-primary hover:underline">
                本番環境情報
              </a>
            </li>
          </ul>
        </div>
      </nav>

      <main className="mx-auto max-w-7xl px-4 py-10 space-y-16">
        {/* アーキテクチャ概要 */}
        <section id="architecture">
          <h2 className="text-2xl font-bold mb-6 flex items-center gap-2">
            <Server className="size-6" />
            アーキテクチャ概要
          </h2>
          <div className="rounded-lg border bg-card p-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <ArchCard
                icon={<Monitor className="size-8 text-blue-600" />}
                title="Web App"
                tech="Next.js 16"
                description="App Router / React 19"
              />
              <ArchCard
                icon={<Server className="size-8 text-violet-600" />}
                title="API Service"
                tech="Express 5"
                description="REST API / Firebase Auth"
              />
              <ArchCard
                icon={<Database className="size-8 text-amber-600" />}
                title="Firestore"
                tech="パスベースマルチテナント"
                description="tenants/{id}/配下に全データ"
              />
            </div>
            <div className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-4">
              <ServiceBadge icon={<Cloud />} label="GCS" detail="動画ストレージ" />
              <ServiceBadge icon={<Shield />} label="Firebase Auth" detail="認証" />
              <ServiceBadge icon={<FileQuestion />} label="Vertex AI" detail="Gemini" />
              <ServiceBadge icon={<BookOpen />} label="Google APIs" detail="Docs / Drive" />
            </div>
            <p className="mt-4 text-sm text-muted-foreground">
              全サービス: Cloud Run (asia-northeast1)
            </p>
          </div>
        </section>

        {/* 画面一覧 */}
        <section id="screens">
          <h2 className="text-2xl font-bold mb-6 flex items-center gap-2">
            <Monitor className="size-6" />
            画面一覧
          </h2>
          <div className="space-y-8">
            {screenSections.map((section) => (
              <div key={section.title}>
                <h3
                  className={`text-lg font-semibold mb-3 flex items-center gap-2 ${section.color}`}
                >
                  {section.icon}
                  {section.title}
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {section.screens.map((screen) => (
                    <div
                      key={screen.name}
                      className={`rounded-lg border p-4 ${section.bgColor} ${section.borderColor}`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        {screen.icon}
                        <span className="font-medium text-sm">
                          {screen.name}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mb-2">
                        {screen.description}
                      </p>
                      <code className="text-xs bg-white/60 rounded px-1.5 py-0.5">
                        {screen.url}
                      </code>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* 運用フロー */}
        <section id="flow">
          <h2 className="text-2xl font-bold mb-6 flex items-center gap-2">
            <ArrowRight className="size-6" />
            運用フロー
          </h2>
          <p className="text-muted-foreground mb-6">
            コース作成から受講者の学習完了までのメインシナリオ
          </p>
          <div className="space-y-4">
            {flowSteps.map((step, i) => (
              <div key={step.step} className="flex gap-4">
                <div className="flex flex-col items-center">
                  <div
                    className={`flex size-8 items-center justify-center rounded-full text-sm font-bold text-white ${
                      step.role === "スーパー管理"
                        ? "bg-violet-600"
                        : step.role === "テナント管理"
                          ? "bg-blue-600"
                          : "bg-emerald-600"
                    }`}
                  >
                    {step.step}
                  </div>
                  {i < flowSteps.length - 1 && (
                    <div className="w-px flex-1 bg-border mt-1" />
                  )}
                </div>
                <div className="pb-6">
                  <div className="flex items-center gap-2">
                    <h4 className="font-semibold">{step.title}</h4>
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full ${
                        step.role === "スーパー管理"
                          ? "bg-violet-100 text-violet-700"
                          : step.role === "テナント管理"
                            ? "bg-blue-100 text-blue-700"
                            : "bg-emerald-100 text-emerald-700"
                      }`}
                    >
                      {step.role}
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">
                    {step.description}
                  </p>
                  {step.details && (
                    <ul className="mt-2 space-y-1">
                      {step.details.map((d) => (
                        <li
                          key={d}
                          className="text-xs text-muted-foreground flex items-center gap-1.5"
                        >
                          <span className="size-1 rounded-full bg-muted-foreground/40" />
                          {d}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* 主要機能 */}
        <section id="features">
          <h2 className="text-2xl font-bold mb-6 flex items-center gap-2">
            <Video className="size-6" />
            主要機能
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {features.map((f) => (
              <div key={f.title} className="rounded-lg border bg-card p-5">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-semibold">{f.title}</h3>
                  {f.reference && (
                    <span className="text-xs text-muted-foreground">
                      {f.reference}
                    </span>
                  )}
                </div>
                <p className="text-sm text-muted-foreground mb-3">
                  {f.description}
                </p>
                <ul className="space-y-1.5">
                  {f.details.map((d) => (
                    <li
                      key={d}
                      className="text-xs text-muted-foreground flex items-start gap-1.5"
                    >
                      <span className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground/40" />
                      {d}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>

        {/* 本番環境情報 */}
        <section id="env">
          <h2 className="text-2xl font-bold mb-6 flex items-center gap-2">
            <Cloud className="size-6" />
            本番環境情報
          </h2>
          <div className="rounded-lg border bg-card overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="text-left px-4 py-3 font-medium">サービス</th>
                  <th className="text-left px-4 py-3 font-medium">URL / 情報</th>
                </tr>
              </thead>
              <tbody>
                <EnvRow label="Web（フロント）" value="https://web-3zcica5euq-an.a.run.app" />
                <EnvRow label="API" value="https://api-3zcica5euq-an.a.run.app" />
                <EnvRow label="GCP Project" value="lms-279" />
                <EnvRow label="Firebase Project" value="lms-279" />
                <EnvRow label="リージョン" value="asia-northeast1" />
              </tbody>
            </table>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t py-8 text-center text-sm text-muted-foreground">
        <p>LMS 279 内部ポータル &copy; {new Date().getFullYear()}</p>
      </footer>
    </>
  );
}

// ─── サブコンポーネント ─────────────────────────

function ArchCard({
  icon,
  title,
  tech,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  tech: string;
  description: string;
}) {
  return (
    <div className="flex flex-col items-center text-center rounded-lg border bg-muted/30 p-5">
      {icon}
      <h3 className="mt-2 font-semibold">{title}</h3>
      <p className="text-sm text-muted-foreground">{tech}</p>
      <p className="text-xs text-muted-foreground mt-1">{description}</p>
    </div>
  );
}

function ServiceBadge({
  icon,
  label,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  detail: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted/20 px-3 py-2 text-sm">
      <span className="text-muted-foreground [&>svg]:size-4">{icon}</span>
      <div>
        <span className="font-medium">{label}</span>
        <span className="text-xs text-muted-foreground ml-1">({detail})</span>
      </div>
    </div>
  );
}

function EnvRow({ label, value }: { label: string; value: string }) {
  return (
    <tr className="border-b last:border-b-0">
      <td className="px-4 py-3 font-medium">{label}</td>
      <td className="px-4 py-3">
        <code className="text-xs bg-muted rounded px-1.5 py-0.5">{value}</code>
      </td>
    </tr>
  );
}
