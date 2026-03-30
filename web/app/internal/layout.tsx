import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "内部ポータル - 介護DX college２７９Classroom",
  description: "介護DX college２７９Classroom 内部向けドキュメント・運用ガイド",
};

export default function InternalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background">
      {children}
    </div>
  );
}
