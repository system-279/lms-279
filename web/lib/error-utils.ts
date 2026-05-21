/**
 * unknown 型のエラー値から `name` プロパティを安全に抽出する。
 *
 * `err instanceof Error` のみだと DOMException (一部環境で Error を継承しない) や
 * カスタム exception を取り損なうため、duck typing で `name: string` を持つ object も
 * 対象にする。
 *
 * 用途: 構造化ログ (Issue #456 middleware / Issue #458 CopyButton 等)。
 */
export function extractErrorName(err: unknown): string {
  if (err instanceof Error) return err.name;
  if (err && typeof err === "object" && "name" in err) {
    const name = (err as { name?: unknown }).name;
    if (typeof name === "string") return name;
  }
  return "unknown";
}
