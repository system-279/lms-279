export const metadata = {
  title: "LMS 279",
  description: "動画視聴管理・クイズ機能統合LMS",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
