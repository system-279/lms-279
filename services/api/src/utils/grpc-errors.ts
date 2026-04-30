/**
 * Firestore / Firebase Admin SDK の例外を transient / permanent に分類するヘルパ。
 *
 * Firestore Admin SDK は `code` プロパティを以下 2 形式のいずれかで返す:
 * - 数値形式: gRPC 標準コード (例: 14 = UNAVAILABLE, 4 = DEADLINE_EXCEEDED)
 * - 文字列形式: kebab-case (例: "unavailable", "deadline-exceeded")
 *
 * 例えば super-admin middleware の `SuperAdminFirestoreUnavailableError` は文字列形式の
 * `code` を保持する。両形式の取りこぼしを防ぐため、両方を判定する。
 */

const TRANSIENT_GRPC_CODES_NUMERIC = new Set<number>([14, 4]);
const TRANSIENT_GRPC_CODES_STRING = new Set<string>(["unavailable", "deadline-exceeded"]);

export function classifyFirestoreError(err: unknown): {
  grpcCode: number | string | undefined;
  isTransient: boolean;
} {
  const code = (err as { code?: number | string })?.code;
  const isTransient =
    (typeof code === "number" && TRANSIENT_GRPC_CODES_NUMERIC.has(code)) ||
    (typeof code === "string" && TRANSIENT_GRPC_CODES_STRING.has(code));
  return { grpcCode: code, isTransient };
}

export const TRANSIENT_RETRY_MESSAGE_JA =
  "サーバーが一時的に利用できません。数秒後に再度お試しください。";
