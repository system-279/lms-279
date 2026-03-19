import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "ヘルプセンター - LMS 279",
  description: "LMS 279の使い方ガイド",
};

export default function HelpLayout({
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
