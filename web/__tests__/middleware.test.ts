import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { middleware, config } from "../middleware";

function makeReq(url: string): NextRequest {
  return new NextRequest(new Request(url));
}

describe("middleware: invisible char path sanitization", () => {
  it("末尾に U+FE0E が混入した path は 308 redirect する", () => {
    const res = middleware(
      makeReq("https://example.com/atali82i/student\u{FE0E}"),
    );
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(
      "https://example.com/atali82i/student",
    );
  });

  it("U+200B (ZWSP) を含む path も 308 redirect", () => {
    const res = middleware(
      makeReq("https://example.com/atali\u{200B}82i/student"),
    );
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(
      "https://example.com/atali82i/student",
    );
  });

  it("クリーンな path は redirect せず素通り", () => {
    const res = middleware(makeReq("https://example.com/atali82i/student"));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("ルート path はそのまま素通り", () => {
    const res = middleware(makeReq("https://example.com/"));
    expect(res.status).toBe(200);
  });

  it("encoded slash (%2F) を path separator に変えない", () => {
    const res = middleware(
      makeReq("https://example.com/courses/a%2Fb/student\u{FE0E}"),
    );
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(
      "https://example.com/courses/a%2Fb/student",
    );
  });

  it("空 segment (//) を保持する", () => {
    const res = middleware(
      makeReq("https://example.com/a//student\u{FE0E}"),
    );
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(
      "https://example.com/a//student",
    );
  });

  it("不正 percent sequence を含む path でも別 segment は救済", () => {
    const res = middleware(
      makeReq("https://example.com/%E0%A4%A/student%EF%B8%8E"),
    );
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(
      "https://example.com/%E0%A4%A/student",
    );
  });

  it("redirect 結果に再度不可視文字が含まれない (loop 防止)", () => {
    const res = middleware(
      makeReq("https://example.com/atali82i/student\u{FE0E}"),
    );
    const location = res.headers.get("location") ?? "";
    expect(location.includes("%EF%B8%8E")).toBe(false);
    expect(location.includes("\u{FE0E}")).toBe(false);
  });
});

describe("middleware: matcher config", () => {
  it("matcher が /api (trailing slash あり/なし) と static asset を除外する", () => {
    const matcher = config.matcher[0];
    expect(matcher).toContain("api(?:/|$)");
    expect(matcher).toContain("_next/static");
    expect(matcher).toContain("_next/image");
    expect(matcher).toContain("favicon.ico");
  });
});
