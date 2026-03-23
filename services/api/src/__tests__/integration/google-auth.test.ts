import { describe, it, expect, vi, beforeEach } from "vitest";

// googleapis をモック
vi.mock("googleapis", () => {
  const mockDrive = { files: { get: vi.fn(), list: vi.fn() } };
  const mockDocs = { documents: { get: vi.fn() } };

  class MockGoogleAuth {
    constructor(_opts: unknown) {
      // no-op
    }
  }

  return {
    google: {
      auth: {
        GoogleAuth: MockGoogleAuth,
      },
      drive: vi.fn().mockReturnValue(mockDrive),
      docs: vi.fn().mockReturnValue(mockDocs),
    },
  };
});

describe("google-auth service", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.GOOGLE_WORKSPACE_ADMIN_EMAIL = "admin@279279.net";
  });

  it("isWorkspaceIntegrationAvailable returns true when env is set", async () => {
    const { isWorkspaceIntegrationAvailable } = await import(
      "../../services/google-auth.js"
    );
    expect(isWorkspaceIntegrationAvailable()).toBe(true);
  });

  it("isWorkspaceIntegrationAvailable returns false when env is unset", async () => {
    delete process.env.GOOGLE_WORKSPACE_ADMIN_EMAIL;
    const { isWorkspaceIntegrationAvailable } = await import(
      "../../services/google-auth.js"
    );
    expect(isWorkspaceIntegrationAvailable()).toBe(false);
  });

  it("getDriveClient returns a Drive client", async () => {
    const { getDriveClient } = await import("../../services/google-auth.js");
    const client = getDriveClient();
    expect(client).toBeDefined();
    expect(client.files).toBeDefined();
  });

  it("getDocsClient returns a Docs client", async () => {
    const { getDocsClient } = await import("../../services/google-auth.js");
    const client = getDocsClient();
    expect(client).toBeDefined();
    expect(client.documents).toBeDefined();
  });

  it("getDriveClient throws when GOOGLE_WORKSPACE_ADMIN_EMAIL is unset", async () => {
    delete process.env.GOOGLE_WORKSPACE_ADMIN_EMAIL;
    const { getDriveClient } = await import("../../services/google-auth.js");
    expect(() => getDriveClient()).toThrow(
      "GOOGLE_WORKSPACE_ADMIN_EMAIL is required"
    );
  });
});
