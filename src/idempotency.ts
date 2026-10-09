export function normalizeKey(key: string): string {
  return key.replace(/\p{Cf}/gu, "").trim().toLowerCase();
}
