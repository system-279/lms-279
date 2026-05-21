import { describe, it, expect, vi, afterEach } from "vitest";
import { selectAllInElement } from "../dom-select";

describe("selectAllInElement (Issue #458)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it("element の全 contents を選択する", () => {
    const el = document.createElement("code");
    el.textContent = "https://example.com/atali82i/student";
    document.body.appendChild(el);
    selectAllInElement(el);
    expect(window.getSelection()?.toString()).toBe(
      "https://example.com/atali82i/student",
    );
  });

  it("既存の選択範囲をクリアしてから選択する", () => {
    const other = document.createElement("p");
    other.textContent = "other text";
    document.body.appendChild(other);
    const range = document.createRange();
    range.selectNodeContents(other);
    window.getSelection()?.addRange(range);

    const code = document.createElement("code");
    code.textContent = "target";
    document.body.appendChild(code);
    selectAllInElement(code);
    expect(window.getSelection()?.toString()).toBe("target");
  });

  it("window.getSelection が null の場合 silent にスキップし console.error を残す", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const getSelectionSpy = vi
      .spyOn(window, "getSelection")
      .mockReturnValue(null);
    const el = document.createElement("code");
    expect(() => selectAllInElement(el)).not.toThrow();
    expect(consoleError).toHaveBeenCalledWith(
      "[dom-select] window.getSelection unavailable",
    );
    getSelectionSpy.mockRestore();
  });

  it("createRange / selectNodeContents が throw した場合 catch して console.error", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const createRangeSpy = vi
      .spyOn(document, "createRange")
      .mockImplementation(() => {
        throw new DOMException("not supported", "NotSupportedError");
      });
    const el = document.createElement("code");
    document.body.appendChild(el);
    expect(() => selectAllInElement(el)).not.toThrow();
    expect(consoleError).toHaveBeenCalledWith(
      "[dom-select] range selection failed",
      expect.objectContaining({ errorName: "NotSupportedError" }),
    );
    createRangeSpy.mockRestore();
  });
});
