import { NextRequest, NextResponse } from "next/server";
import { sanitizeEncodedPathnameForRedirect } from "@/lib/sanitize-path";

/**
 * Issue #456: URL パスに混入した不可視文字 (U+FE0E 等) を除去して 308 redirect する。
 *
 * Next.js は req.nextUrl.pathname を percent-encoded で受け取る (WHATWG URL 準拠)。
 * segment 単位で decode → sanitize → re-encode することで、encoded path separator (`%2F`)
 * を path separator に化けさせず、不正 percent sequence を含む segment があっても部分救済する。
 * 検出対象は __tests__/middleware.test.ts のケース参照。
 */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const { needsRedirect, cleaned } = sanitizeEncodedPathnameForRedirect(pathname);
  if (!needsRedirect) {
    return NextResponse.next();
  }
  const url = req.nextUrl.clone();
  url.pathname = cleaned;
  return NextResponse.redirect(url, 308);
}

// matcher: static asset と /api 以下を除外。`api(?:/|$)` で `/api` 自体も除外。
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api(?:/|$)).*)"],
};
