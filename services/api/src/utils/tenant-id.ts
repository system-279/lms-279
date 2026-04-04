/**
 * テナントID生成ユーティリティ
 * tenants.ts と super-admin.ts の両方から使用
 */

/**
 * 予約済みテナントID（ルートと競合するID）
 */
export const RESERVED_TENANT_IDS = new Set([
  "demo",
  "admin",
  "student",
  "api",
  "tenants",
  "register",
  "login",
  "logout",
  "auth",
  "healthz",
  "static",
  "public",
  "_next",
  "favicon",
  "robots",
  "sitemap",
  "_master",
  "super",
  "help",
]);

/**
 * テナントID生成（8文字のランダム英数字）
 * 予約済みIDとの衝突を回避する
 */
export function generateTenantId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  for (let attempt = 0; attempt < 100; attempt++) {
    let result = "";
    for (let i = 0; i < 8; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    if (!RESERVED_TENANT_IDS.has(result)) return result;
  }
  throw new Error("Failed to generate non-reserved tenant ID");
}

/**
 * 組織名のバリデーション
 * @returns trimされた組織名、無効な場合はnull
 */
export function validateOrganizationName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 100) return null;
  return trimmed;
}

/**
 * メールアドレスの正規化
 */
export function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}
