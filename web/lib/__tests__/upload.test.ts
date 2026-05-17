import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { uploadFileWithProgress, UploadError } from "../upload";

interface MockXHRInstance {
  upload: {
    listeners: Record<string, (event: Partial<ProgressEvent>) => void>;
    addEventListener: (type: string, listener: (event: Partial<ProgressEvent>) => void) => void;
  };
  listeners: Record<string, () => void>;
  addEventListener: (type: string, listener: () => void) => void;
  open: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  setRequestHeader: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  status: number;
  statusText: string;
}

let xhrInstances: MockXHRInstance[] = [];

class MockXMLHttpRequest {
  upload = {
    listeners: {} as Record<string, (event: Partial<ProgressEvent>) => void>,
    addEventListener(type: string, listener: (event: Partial<ProgressEvent>) => void) {
      this.listeners[type] = listener;
    },
  };
  listeners: Record<string, () => void> = {};
  status = 0;
  statusText = "";
  open = vi.fn();
  send = vi.fn();
  setRequestHeader = vi.fn();
  abort = vi.fn(() => {
    this.listeners.abort?.();
  });
  addEventListener = vi.fn(
    (type: string, listener: () => void) => {
      this.listeners[type] = listener;
    },
  );

  constructor() {
    xhrInstances.push(this as unknown as MockXHRInstance);
  }
}

function triggerProgress(instance: MockXHRInstance, loaded: number, total: number) {
  instance.upload.listeners.progress?.({
    loaded,
    total,
    lengthComputable: true,
  } as Partial<ProgressEvent>);
}

function triggerLoad(instance: MockXHRInstance, status: number, statusText = "") {
  instance.status = status;
  instance.statusText = statusText;
  instance.listeners.load?.();
  instance.listeners.loadend?.();
}

function triggerError(instance: MockXHRInstance) {
  instance.listeners.error?.();
  instance.listeners.loadend?.();
}

describe("uploadFileWithProgress", () => {
  const originalXHR = global.XMLHttpRequest;

  beforeEach(() => {
    xhrInstances = [];
    global.XMLHttpRequest = MockXMLHttpRequest as unknown as typeof XMLHttpRequest;
  });

  afterEach(() => {
    global.XMLHttpRequest = originalXHR;
  });

  function makeFile(): File {
    return new File(["pdf content"], "test.pdf", { type: "application/pdf" });
  }

  it("HTTP 200 で resolve する", async () => {
    const file = makeFile();
    const promise = uploadFileWithProgress(file, "https://gcs.example.com/put");
    expect(xhrInstances).toHaveLength(1);
    triggerLoad(xhrInstances[0], 200);
    await expect(promise).resolves.toBeUndefined();
  });

  it("HTTP 500 で UploadError(kind: http, status: 500) を reject", async () => {
    const file = makeFile();
    const promise = uploadFileWithProgress(file, "https://gcs.example.com/put");
    triggerLoad(xhrInstances[0], 500, "Internal Server Error");
    await expect(promise).rejects.toMatchObject({
      kind: "http",
      status: 500,
    });
  });

  it("network error で UploadError(kind: network) を reject", async () => {
    const file = makeFile();
    const promise = uploadFileWithProgress(file, "https://gcs.example.com/put");
    triggerError(xhrInstances[0]);
    await expect(promise).rejects.toMatchObject({ kind: "network" });
  });

  it("progress callback が 0-100 の整数で呼ばれる", async () => {
    const file = makeFile();
    const onProgress = vi.fn();
    const promise = uploadFileWithProgress(
      file,
      "https://gcs.example.com/put",
      onProgress,
    );
    triggerProgress(xhrInstances[0], 50, 100);
    triggerProgress(xhrInstances[0], 100, 100);
    triggerLoad(xhrInstances[0], 200);
    await promise;
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ percent: 50, loaded: 50, total: 100 }),
    );
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ percent: 100, loaded: 100, total: 100 }),
    );
  });

  it("AbortSignal.abort() で UploadError(kind: aborted) を reject + xhr.abort 呼出", async () => {
    const file = makeFile();
    const controller = new AbortController();
    const promise = uploadFileWithProgress(
      file,
      "https://gcs.example.com/put",
      undefined,
      controller.signal,
    );
    controller.abort();
    await expect(promise).rejects.toMatchObject({ kind: "aborted" });
    expect(xhrInstances[0].abort).toHaveBeenCalled();
  });

  it("既に abort された signal を渡すと XHR を作らず即 reject", async () => {
    const controller = new AbortController();
    controller.abort();
    const file = makeFile();
    const promise = uploadFileWithProgress(
      file,
      "https://gcs.example.com/put",
      undefined,
      controller.signal,
    );
    await expect(promise).rejects.toBeInstanceOf(UploadError);
  });

  it("Content-Type ヘッダにファイル MIME を設定する", async () => {
    const file = makeFile();
    const promise = uploadFileWithProgress(file, "https://gcs.example.com/put");
    expect(xhrInstances[0].setRequestHeader).toHaveBeenCalledWith(
      "Content-Type",
      "application/pdf",
    );
    triggerLoad(xhrInstances[0], 200);
    await promise;
  });
});
