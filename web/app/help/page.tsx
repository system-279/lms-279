import Link from "next/link";
import { HelpContent } from "./_components/HelpContent";

export default function HelpPage() {
  return (
    <>
      {/* Header */}
      <header className="sticky top-0 z-40 border-b bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4">
          <Link href="/help" className="font-semibold">
            LMS 279 ヘルプセンター
          </Link>
          <Link
            href="/"
            className="text-sm text-muted-foreground hover:text-foreground transition"
          >
            LMS に戻る
          </Link>
        </div>
      </header>

      <HelpContent />

      {/* Footer */}
      <footer className="border-t py-8 text-center text-sm text-muted-foreground">
        <p>LMS 279 &copy; {new Date().getFullYear()}</p>
      </footer>
    </>
  );
}
