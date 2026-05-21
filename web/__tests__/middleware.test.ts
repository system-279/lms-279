import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "../middleware";

function makeReq(url: string): NextRequest {
  return new NextRequest(new Request(url));
}

describe("middleware: invisible char path sanitization", () => {
  it("末尾に U+FE0E が混入した path は 308 redirect する", () => {
    const res = middleware(
      makeReq("https://example.com/atali82i/student\u{FE0E}"),
    );
    expect(res.status).toBe(308);
    const loc = res.headers.get("location");
    expect(loc).toBe("https://example.com/atali82i/student");
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
    // NextResponse.next() returns 200 with the x-middleware-next header
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("ルート path はそのまま素通り", () => {
    const res = middleware(makeReq("https://example.com/"));
    expect(res.status).toBe(200);
  });
});
