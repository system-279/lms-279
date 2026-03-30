/** ISO UTC文字列をdatetime-local用のローカル時刻文字列に変換 */
export function isoToDatetimeLocal(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day}T${h}:${min}`;
}

/** datetime-local値をISO UTC文字列に変換 */
export function datetimeLocalToISO(local: string): string {
  return new Date(local).toISOString();
}
