/*
 * Extension versions as Chrome writes them in manifest.json: one to four dot-separated whole
 * numbers ("1.0.0"). The server tells the popup the version it serves (ExtensionSession
 * .latestVersion), and the footer suggests the download when that one is newer.
 */

const VERSION = /^\d{1,9}(\.\d{1,9}){0,3}$/;

function parts(version: string) {
  return VERSION.test(version) ? version.split(".").map(Number) : null;
}

/** -1, 0 or 1 like a sort comparator ("1.2" equals "1.2.0"); null when either is not a version. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const left = parts(a);
  const right = parts(b);
  if (!left || !right) return null;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/** True only when `latest` is a version newer than `current`. */
export function isNewerVersion(latest: string | null, current: string) {
  return latest !== null && compareVersions(latest, current) === 1;
}
