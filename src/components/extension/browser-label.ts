/**
 * The label a connected browser gets in Settings ("Chrome on Linux", "Edge on Windows"), made on
 * the connect page from what the browser says about itself. User-Agent Client Hints first
 * (Chromium browsers: navigator.userAgentData), the User-Agent string otherwise. Only a hint for
 * the owner to tell their browsers apart, never a check.
 */

/** When the browser can't be told: still says what was connected. */
export const DEFAULT_BROWSER_LABEL = "Chrome extension";

/** POST /api/extension/keys takes 1 to 80 characters. */
export const MAX_LABEL_LENGTH = 80;

/** What the helper reads; navigator in the browser, a plain object in the tests. */
export interface BrowserInfo {
  userAgent?: string;
  userAgentData?: {
    brands?: ReadonlyArray<{ brand: string; version?: string }>;
    platform?: string;
  } | null;
}

/** Client Hints brands, most specific first: Chromium browsers also list "Chromium". */
const BRANDS: Array<[brand: string, name: string]> = [
  ["Microsoft Edge", "Edge"],
  ["Brave", "Brave"],
  ["Opera", "Opera"],
  ["Vivaldi", "Vivaldi"],
  ["Google Chrome", "Chrome"],
  ["HeadlessChrome", "Chrome"],
  ["Chromium", "Chromium"],
];

/** User-Agent tokens, most specific first: Edge and Opera also say "Chrome/". */
const UA_BROWSERS: Array<[pattern: RegExp, name: string]> = [
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\b(?:OPR|Opera)\//, "Opera"],
  [/\bVivaldi\//, "Vivaldi"],
  [/\bFirefox\//, "Firefox"],
  [/\b(?:Headless)?Chrome\//, "Chrome"],
  [/\bChromium\//, "Chromium"],
  [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
];

/** Client Hints platform names as people say them. */
const PLATFORMS: Record<string, string> = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
  "chrome os": "ChromeOS",
  chromeos: "ChromeOS",
  "chromium os": "ChromeOS",
  android: "Android",
  ios: "iOS",
};

/** User-Agent platforms, most specific first: Android also says "Linux", ChromeOS "X11". */
const UA_PLATFORMS: Array<[pattern: RegExp, name: string]> = [
  [/\bAndroid\b/, "Android"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\b(?:iPhone|iPad|iPod)\b/, "iOS"],
  [/\bWindows\b/, "Windows"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bLinux\b|\bX11\b/, "Linux"],
];

function browserName({ userAgent = "", userAgentData }: BrowserInfo): string | null {
  const brands = new Set((userAgentData?.brands ?? []).map((b) => b.brand));
  for (const [brand, name] of BRANDS) if (brands.has(brand)) return name;
  for (const [pattern, name] of UA_BROWSERS) if (pattern.test(userAgent)) return name;
  return null;
}

function platformName({ userAgent = "", userAgentData }: BrowserInfo): string | null {
  const hinted = userAgentData?.platform?.trim().toLowerCase();
  if (hinted && PLATFORMS[hinted]) return PLATFORMS[hinted];
  for (const [pattern, name] of UA_PLATFORMS) if (pattern.test(userAgent)) return name;
  return null;
}

/** "Chrome on Linux", "Edge" (platform unknown), or DEFAULT_BROWSER_LABEL; at most 80 characters. */
export function browserLabel(info: BrowserInfo): string {
  const browser = browserName(info);
  if (!browser) return DEFAULT_BROWSER_LABEL;
  const platform = platformName(info);
  return (platform ? `${browser} on ${platform}` : browser).slice(0, MAX_LABEL_LENGTH);
}

/** The label of the browser this page runs in. Call it in the browser only. */
export function currentBrowserLabel(): string {
  if (typeof navigator === "undefined") return DEFAULT_BROWSER_LABEL;
  const { userAgent, userAgentData } = navigator as Navigator & { userAgentData?: BrowserInfo["userAgentData"] };
  return browserLabel({ userAgent, userAgentData });
}
