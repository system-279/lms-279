import { NextRequest, NextResponse } from "next/server";
import { sanitizePathForRedirect } from "@/lib/sanitize-path";

/**
 * Issue #456: URL パスに混入した不可視文字 (U+FE0E 等) を除去して 308 redirect する。
 *
 * 経路上の URL コンストラクタが不可視文字を percent-encode するため、
 * middleware に届く pathname は ASCII 化されている。decode → sanitize → encode の
 * パイプラインで Unicode レベルの検出と除去を行う。
 */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return NextResponse.next();
  }

  const { needsRedirect, cleaned } = sanitizePathForRedirect(decoded);
  if (!needsRedirect) {
    return NextResponse.next();
  }

  const url = req.nextUrl.clone();
  url.pathname = cleaned
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return NextResponse.redirect(url, 308);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/).*)"],
};
