import { describe, it, expect, beforeEach } from "vitest";

describe("google-drive service", () => {
  describe("parseDriveUrl", () => {
    let parseDriveUrl: (url: string) => string;

    beforeEach(async () => {
      const mod = await import("../../services/google-drive.js");
      parseDriveUrl = mod.parseDriveUrl;
    });

    it("parses /file/d/{id}/view format", () => {
      expect(
        parseDriveUrl("https://drive.google.com/file/d/1abc_DEF-xyz/view")
      ).toBe("1abc_DEF-xyz");
    });

    it("parses /file/d/{id}/view?usp=sharing format", () => {
      expect(
        parseDriveUrl(
          "https://drive.google.com/file/d/1abc_DEF-xyz/view?usp=sharing"
        )
      ).toBe("1abc_DEF-xyz");
    });

    it("parses /open?id={id} format", () => {
      expect(
        parseDriveUrl("https://drive.google.com/open?id=1abc_DEF-xyz")
      ).toBe("1abc_DEF-xyz");
    });

    it("parses /file/d/{id}/edit format", () => {
      expect(
        parseDriveUrl("https://drive.google.com/file/d/1abc_DEF-xyz/edit")
      ).toBe("1abc_DEF-xyz");
    });

    it("parses /file/d/{id} without trailing path", () => {
      expect(
        parseDriveUrl("https://drive.google.com/file/d/1abc_DEF-xyz")
      ).toBe("1abc_DEF-xyz");
    });

    it("throws for invalid URL", () => {
      expect(() => parseDriveUrl("https://example.com/file")).toThrow(
        "Invalid Google Drive URL"
      );
    });

    it("throws for empty string", () => {
      expect(() => parseDriveUrl("")).toThrow("Invalid Google Drive URL");
    });

    it("throws for Google Docs URL", () => {
      expect(() =>
        parseDriveUrl("https://docs.google.com/document/d/abc/edit")
      ).toThrow("Invalid Google Drive URL");
    });
  });

  describe("validateDriveFileMetadata", () => {
    let validateDriveFileMetadata: (metadata: {
      mimeType: string;
      size: string;
      name: string;
    }) => void;

    beforeEach(async () => {
      const mod = await import("../../services/google-drive.js");
      validateDriveFileMetadata = mod.validateDriveFileMetadata;
    });

    it("accepts video/mp4", () => {
      expect(() =>
        validateDriveFileMetadata({
          mimeType: "video/mp4",
          size: "1000000",
          name: "test.mp4",
        })
      ).not.toThrow();
    });

    it("accepts video/webm", () => {
      expect(() =>
        validateDriveFileMetadata({
          mimeType: "video/webm",
          size: "1000000",
          name: "test.webm",
        })
      ).not.toThrow();
    });

    it("rejects non-video mimeType", () => {
      expect(() =>
        validateDriveFileMetadata({
          mimeType: "application/pdf",
          size: "1000000",
          name: "test.pdf",
        })
      ).toThrow("not a video file");
    });

    it("rejects file exceeding 5GB", () => {
      const fiveGBPlus = String(5 * 1024 * 1024 * 1024 + 1);
      expect(() =>
        validateDriveFileMetadata({
          mimeType: "video/mp4",
          size: fiveGBPlus,
          name: "huge.mp4",
        })
      ).toThrow("exceeds the 5GB limit");
    });

    it("accepts file at exactly 5GB", () => {
      const fiveGB = String(5 * 1024 * 1024 * 1024);
      expect(() =>
        validateDriveFileMetadata({
          mimeType: "video/mp4",
          size: fiveGB,
          name: "big.mp4",
        })
      ).not.toThrow();
    });
  });
});
