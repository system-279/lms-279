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

// セクションデータはロール別ファイルに分割済み
// student-sections.ts / admin-sections.ts / super-sections.ts を参照
