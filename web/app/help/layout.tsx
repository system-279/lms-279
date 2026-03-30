import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "ヘルプセンター - 介護DX college２７９Classroom",
  description: "介護DX college２７９Classroomの使い方ガイド",
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
