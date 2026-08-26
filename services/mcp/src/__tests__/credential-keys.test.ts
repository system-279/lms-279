import { describe, it, expect, vi, beforeEach } from "vitest";

const accessSecretVersionMock = vi.fn();

vi.mock("@google-cloud/secret-manager", () => ({
  SecretManagerServiceClient: vi.fn().mockImplementation(function (this: { accessSecretVersion: typeof accessSecretVersionMock }) {
    this.accessSecretVersion = accessSecretVersionMock;
  }),
}));

const { getCredentialKeysFromSecretManager } = await import("../credential-keys.js");

describe("getCredentialKeysFromSecretManager", () => {
  beforeEach(() => {
    accessSecretVersionMock.mockReset();
  });

  it("正しい形の secret を取得し keyring/activeVersion を返す", async () => {
    const validKey = Buffer.alloc(32, 1).toString("base64");
    accessSecretVersionMock.mockResolvedValue([
      {
        payload: {
          data: JSON.stringify({
            keys: [{ version: 1, key: validKey }],
            activeVersion: 1,
          }),
        },
      },
    ]);

    const result = await getCredentialKeysFromSecretManager("projects/p/secrets/s/versions/latest");

    expect(result.activeVersion).toBe(1);
    expect(result.keys).toHaveLength(1);
    expect(result.keys[0]?.version).toBe(1);
    expect(result.keys[0]?.key).toBeInstanceOf(Buffer);
    expect(result.keys[0]?.key.length).toBe(32);
  });

  it("payload が空の場合は例外を投げる", async () => {
    accessSecretVersionMock.mockResolvedValue([{ payload: {} }]);

    await expect(getCredentialKeysFromSecretManager("projects/p/secrets/s/versions/latest")).rejects.toThrow();
  });

  it("keys 配列が空の場合は例外を投げる", async () => {
    accessSecretVersionMock.mockResolvedValue([
      { payload: { data: JSON.stringify({ keys: [], activeVersion: 1 }) } },
    ]);

    await expect(getCredentialKeysFromSecretManager("projects/p/secrets/s/versions/latest")).rejects.toThrow();
  });

  it("activeVersion が keys に存在しない場合は例外を投げる", async () => {
    const validKey = Buffer.alloc(32, 1).toString("base64");
    accessSecretVersionMock.mockResolvedValue([
      {
        payload: {
          data: JSON.stringify({ keys: [{ version: 1, key: validKey }], activeVersion: 2 }),
        },
      },
    ]);

    await expect(getCredentialKeysFromSecretManager("projects/p/secrets/s/versions/latest")).rejects.toThrow();
  });

  it("keyの長さが32byteでない場合は例外を投げる（AES-256要件）", async () => {
    const shortKey = Buffer.alloc(16, 1).toString("base64");
    accessSecretVersionMock.mockResolvedValue([
      {
        payload: {
          data: JSON.stringify({ keys: [{ version: 1, key: shortKey }], activeVersion: 1 }),
        },
      },
    ]);

    await expect(getCredentialKeysFromSecretManager("projects/p/secrets/s/versions/latest")).rejects.toThrow();
  });

  it("JSONとして不正な場合は例外を投げる", async () => {
    accessSecretVersionMock.mockResolvedValue([{ payload: { data: "not json" } }]);

    await expect(getCredentialKeysFromSecretManager("projects/p/secrets/s/versions/latest")).rejects.toThrow();
  });
});
