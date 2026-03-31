/**
 * Global floating promo chips (mobile). Configure via `READER_FLOATING_PROMO_JSON` — JSON array.
 * First enabled promo that passes client-side visibility rules is shown (see mobile app).
 *
 * Example:
 * ```json
 * [
 *   {
 *     "id": "spring-sale",
 *     "enabled": true,
 *     "label": "SALE",
 *     "iconName": "sell",
 *     "gradientColors": ["#1e293b", "#0f172a"],
 *     "labelColor": "#f4c025",
 *     "iconColor": "#f4c025",
 *     "anchor": "bottom-end",
 *     "insetBottom": 88,
 *     "insetEnd": 12,
 *     "borderRadius": 12,
 *     "linkType": "rankings",
 *     "linkTarget": "rankings",
 *     "dismissible": true,
 *     "hiddenPathPrefixes": ["/read/", "/top-up"]
 *   }
 * ]
 * ```
 *
 * `linkType` / `linkTarget`: same contract as dashboard promo carousel (`dashboard-promo-carousel.ts`).
 */

import type { ReaderDashboardPromoLinkType } from "./dashboard-promo-carousel";

const LINK_TYPES = new Set<ReaderDashboardPromoLinkType>([
  "story",
  "story_read",
  "rankings",
  "search",
  "library",
  "profile",
  "external_url",
  "in_app_path",
]);

export type ReaderFloatingPromoAnchor =
  | "bottom-end"
  | "bottom-start"
  | "top-end"
  | "top-start";

export type ReaderFloatingPromo = {
  id: string;
  enabled: boolean;
  label: string;
  iconName: string | null;
  gradientColors: [string, string] | null;
  backgroundColor: string | null;
  labelColor: string | null;
  iconColor: string | null;
  anchor: ReaderFloatingPromoAnchor;
  insetBottom: number | null;
  insetTop: number | null;
  insetEnd: number | null;
  insetStart: number | null;
  minWidth: number | null;
  borderRadius: number | null;
  elevation: number | null;
  linkType: ReaderDashboardPromoLinkType;
  linkTarget: string;
  readChapterSlug: string | null;
  dismissible: boolean;
  hiddenPathPrefixes: string[];
  labelFontSize: number | null;
  letterSpacing: number | null;
};

function asNonEmptyString(v: unknown): string | null {
  if (typeof v !== "string") {
    return null;
  }
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function asFiniteNumber(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return null;
  }
  return v;
}

function asStringPair(v: unknown): [string, string] | null {
  if (!Array.isArray(v) || v.length !== 2) {
    return null;
  }
  const a = asNonEmptyString(v[0]);
  const b = asNonEmptyString(v[1]);
  if (!a || !b) {
    return null;
  }
  return [a, b];
}

const ANCHORS = new Set<ReaderFloatingPromoAnchor>([
  "bottom-end",
  "bottom-start",
  "top-end",
  "top-start",
]);

function normalizePromo(item: unknown): ReaderFloatingPromo | null {
  if (!item || typeof item !== "object") {
    return null;
  }
  const o = item as Record<string, unknown>;
  const id = asNonEmptyString(o.id);
  const label = asNonEmptyString(o.label);
  const linkTypeRaw = asNonEmptyString(o.linkType);
  const linkTarget = asNonEmptyString(o.linkTarget);
  if (!id || !label || !linkTypeRaw || !linkTarget) {
    return null;
  }
  if (!LINK_TYPES.has(linkTypeRaw as ReaderDashboardPromoLinkType)) {
    return null;
  }
  const linkType = linkTypeRaw as ReaderDashboardPromoLinkType;
  if (linkType === "external_url" && !/^https?:\/\//i.test(linkTarget)) {
    return null;
  }
  if (linkType === "in_app_path" && !linkTarget.startsWith("/")) {
    return null;
  }

  const enabled = o.enabled === false ? false : true;

  let anchor: ReaderFloatingPromoAnchor = "bottom-end";
  const an = asNonEmptyString(o.anchor);
  if (an && ANCHORS.has(an as ReaderFloatingPromoAnchor)) {
    anchor = an as ReaderFloatingPromoAnchor;
  }

  const gradientColors = asStringPair(o.gradientColors);
  const backgroundColor = asNonEmptyString(o.backgroundColor);

  let hiddenPathPrefixes: string[] = [];
  if (Array.isArray(o.hiddenPathPrefixes)) {
    hiddenPathPrefixes = o.hiddenPathPrefixes
      .map((x) => (typeof x === "string" ? x.trim() : ""))
      .filter((x) => x.length > 0);
  }

  return {
    id,
    enabled,
    label,
    iconName: asNonEmptyString(o.iconName),
    gradientColors,
    backgroundColor,
    labelColor: asNonEmptyString(o.labelColor),
    iconColor: asNonEmptyString(o.iconColor),
    anchor,
    insetBottom: asFiniteNumber(o.insetBottom),
    insetTop: asFiniteNumber(o.insetTop),
    insetEnd: asFiniteNumber(o.insetEnd),
    insetStart: asFiniteNumber(o.insetStart),
    minWidth: asFiniteNumber(o.minWidth),
    borderRadius: asFiniteNumber(o.borderRadius),
    elevation: asFiniteNumber(o.elevation),
    linkType,
    linkTarget,
    readChapterSlug: asNonEmptyString(o.readChapterSlug),
    dismissible: o.dismissible === true,
    hiddenPathPrefixes,
    labelFontSize: asFiniteNumber(o.labelFontSize),
    letterSpacing: asFiniteNumber(o.letterSpacing),
  };
}

export function parseFloatingPromosFromEnv(): ReaderFloatingPromo[] {
  const raw = process.env.READER_FLOATING_PROMO_JSON;
  if (!raw?.trim()) {
    return [];
  }
  try {
    const data = JSON.parse(raw) as unknown;
    if (!Array.isArray(data)) {
      return [];
    }
    const out: ReaderFloatingPromo[] = [];
    for (const item of data) {
      const p = normalizePromo(item);
      if (p) {
        out.push(p);
      }
    }
    return out;
  } catch {
    return [];
  }
}
