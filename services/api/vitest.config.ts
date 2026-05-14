import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    exclude: ["**/node_modules/**", "**/dist/**"],
    // progress-pdf-draft.test.ts の vi.mock("firebase-admin/firestore") が
    // 並列実行下で他の super-admin 系テストに干渉するため、ファイル並列を無効化。
    // (vitest は worker pool 内で module isolation を保証するが、firebase-admin SDK が
    //  global state (apps cache) を持つため worker 跨ぎで影響が出る)
    fileParallelism: false,
  },
});
