import { describe, it, expect } from "vitest";
import { extractUid } from "../mcp-server.js";
import type { ServerContext } from "@modelcontextprotocol/server";

function makeCtx(accountId: unknown): ServerContext {
  return {
    http: accountId === "NO_HTTP" ? undefined : { authInfo: accountId === "NO_AUTHINFO" ? undefined : { extra: { accountId } } },
  } as unknown as ServerContext;
}

describe("extractUid", () => {
  it("正常な文字列accountIdを返す", () => {
    expect(extractUid(makeCtx("uid-1"))).toBe("uid-1");
  });

  it("accountIdが空文字の場合はundefinedを返す", () => {
    expect(extractUid(makeCtx(""))).toBeUndefined();
  });

  it("accountIdが数値等の非文字列の場合はundefinedを返す", () => {
    expect(extractUid(makeCtx(12345))).toBeUndefined();
  });

  it("authInfoが存在しない場合はundefinedを返す", () => {
    expect(extractUid(makeCtx("NO_AUTHINFO"))).toBeUndefined();
  });

  it("httpが存在しない場合はundefinedを返す（serveStdio等のHTTP以外の経路を想定）", () => {
    expect(extractUid(makeCtx("NO_HTTP"))).toBeUndefined();
  });
});
