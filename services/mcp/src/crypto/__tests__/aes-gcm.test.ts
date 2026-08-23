import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { encryptWithKey, decryptWithKeyring, type KeyringEntry } from "../aes-gcm.js";

function makeKey(): Buffer {
  return randomBytes(32);
}

describe("aes-gcm 暗号化/復号", () => {
  it("暗号化した平文を同じ鍵で復号すると元に戻る（ラウンドトリップ）", () => {
    const key = makeKey();
    const plaintext = "super-secret-refresh-token-value";

    const ciphertext = encryptWithKey(plaintext, key, 1);
    const decrypted = decryptWithKeyring(ciphertext, [{ version: 1, key }]);

    expect(decrypted).toBe(plaintext);
  });

  it("暗号文には平文がそのまま含まれない", () => {
    const key = makeKey();
    const plaintext = "super-secret-refresh-token-value";

    const ciphertext = encryptWithKey(plaintext, key, 1);

    expect(ciphertext).not.toContain(plaintext);
  });

  it("誤った鍵で復号すると例外を投げる", () => {
    const key = makeKey();
    const wrongKey = makeKey();
    const ciphertext = encryptWithKey("plaintext", key, 1);

    expect(() => decryptWithKeyring(ciphertext, [{ version: 1, key: wrongKey }])).toThrow();
  });

  it("鍵ローテーション後も旧バージョン鍵で暗号化された値を復号できる（release gate要件）", () => {
    const oldKey = makeKey();
    const newKey = makeKey();
    const ciphertext = encryptWithKey("plaintext-with-old-key", oldKey, 1);

    // ローテーション後の鍵環には新旧両方が含まれる想定
    const decrypted = decryptWithKeyring(ciphertext, [
      { version: 2, key: newKey },
      { version: 1, key: oldKey },
    ] satisfies KeyringEntry[]);

    expect(decrypted).toBe("plaintext-with-old-key");
  });

  it("鍵環にciphertextのバージョンが存在しない場合は例外を投げる", () => {
    const key = makeKey();
    const ciphertext = encryptWithKey("plaintext", key, 5);

    expect(() => decryptWithKeyring(ciphertext, [{ version: 1, key }])).toThrow();
  });

  it("GCM認証タグによる改ざん検知: 暗号文を1文字変えると復号に失敗する", () => {
    const key = makeKey();
    const ciphertext = encryptWithKey("plaintext", key, 1);
    const parsed = JSON.parse(Buffer.from(ciphertext, "base64url").toString("utf8")) as {
      v: number;
      iv: string;
      tag: string;
      data: string;
    };
    // data の先頭1バイトを改ざんする
    const tamperedDataBuf = Buffer.from(parsed.data, "base64url");
    tamperedDataBuf[0] = (tamperedDataBuf[0] ?? 0) ^ 0xff;
    const tampered = { ...parsed, data: tamperedDataBuf.toString("base64url") };
    const tamperedCiphertext = Buffer.from(JSON.stringify(tampered), "utf8").toString("base64url");

    expect(() => decryptWithKeyring(tamperedCiphertext, [{ version: 1, key }])).toThrow();
  });

  it("同じ平文・同じ鍵でも暗号化するたびに異なる暗号文になる（IVがランダム）", () => {
    const key = makeKey();
    const c1 = encryptWithKey("same-plaintext", key, 1);
    const c2 = encryptWithKey("same-plaintext", key, 1);

    expect(c1).not.toBe(c2);
  });
});
