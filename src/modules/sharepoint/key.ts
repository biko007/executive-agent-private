/**
 * sharepoint/key — Canonical sp_item_key construction.
 *
 * MUST produce identical output to shared/links/index.ts:183:
 *   f.siteId + "::" + f.driveId + "::" + f.path
 *
 * No normalization, no URL-decode, no trim, no unicode normalization.
 * Case-sensitive, separator is exactly "::" (two colons, no whitespace).
 */

export function buildSpItemKey(siteId: string, driveId: string, path: string): string {
  return `${siteId}::${driveId}::${path}`;
}
