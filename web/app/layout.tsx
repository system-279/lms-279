import type { ReactNode } from "react";
import { AuthProvider } from "../lib/auth-context";
import { AuthFetchProvider } from "../lib/auth-fetch-context";
import "./globals.css";

export const metadata = {
  title: "LMS 279",
  description: "Learning Management System",
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
