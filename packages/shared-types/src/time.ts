/**
 * 時刻関連の共通定数。
 *
 * ADR-029 (タイムゾーン基準) に基づき、JST は固定 UTC+9 (DST なし) として扱う。
 * 過去複数箇所で `9 * 60 * 60 * 1000` を再定義していたため shared-types に集約する
 * (Phase 1 PR #442 review Important #8)。
 */

/** JST と UTC のオフセット (ミリ秒)。ADR-029 により固定 UTC+9 / DST なし。 */
export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
