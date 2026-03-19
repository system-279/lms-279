import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AuthProvider } from "../lib/auth-context";
import { AuthFetchProvider } from "../lib/auth-fetch-context";
import "./globals.css";

export const metadata: Metadata = {
  title: "LMS 279",
  description: "株式会社279 つなぐ手 学習管理システム",
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/favicon.ico", sizes: "32x32" },
    ],
    apple: "/apple-touch-icon.png",
  },
  manifest: "/manifest.json",
};

export default function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <html lang="ja">
      <body>
        <AuthProvider>
          <AuthFetchProvider>{children}</AuthFetchProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
