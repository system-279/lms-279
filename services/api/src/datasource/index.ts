/**
 * DataSource エクスポート
 */

export type { DataSource, TenantContext } from "./interface.js";
export {
  ReadOnlyDataSourceError,
  type CourseFilter,
  type LessonFilter,
  type NotificationPolicyFilter,
  type AuthErrorLogFilter,
  type CourseUpdateData,
  type LessonUpdateData,
  type UserUpdateData,
  type NotificationPolicyUpdateData,
} from "./interface.js";
export { InMemoryDataSource } from "./in-memory.js";
export { FirestoreDataSource } from "./firestore.js";
export { getDataSource } from "./factory.js";
