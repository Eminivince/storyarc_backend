/**
 * Dashboard promo hero carousel (mobile + any client that reads `promoCarousel`).
 *
 * Configure via env `READER_DASHBOARD_PROMO_CAROUSEL_JSON` — a JSON array of slides.
 * Example:
 * ```json
 * [
 *   {
 *     "id": "return-gifts",
 *     "imageUrl": "https://cdn.example.com/promo/return-gifts.png",
 *     "title": "Gifts for coming back!",
 *     "subtitle": "Exclusive Offer For You",
 *     "badgeText": "Events",
 *     "badgeType": "events",
 *     "cardCtaText": "CLAIM",
 *     "linkType": "in_app_path",
 *     "linkTarget": "/rankings"
 *   }
 * ]
 * ```
 *
 * `linkType`: story | story_read | rankings | search | library | profile | external_url | in_app_path
 * - story → linkTarget = story slug (opens story detail in app)
 * - story_read → linkTarget = story slug; optional `readChapterSlug` on slide for deep link
 * - external_url → full https URL
 * - in_app_path → path starting with / (e.g. /top-up, /stories/my-slug)
 */

export type ReaderDashboardPromoBadgeType = "events" | "sale" | "spotlight" | "default";

export type ReaderDashboardPromoLinkType =
  | "story"
  | "story_read"
  | "rankings"
  | "search"
  | "library"
  | "profile"
  | "external_url"
  | "in_app_path";

export type ReaderDashboardPromoSlide = {
  badgeText?: string | null;
  badgeType?: ReaderDashboardPromoBadgeType | null;
  cardCtaText?: string | null;
  id: string;
  imageUrl: string;
  linkTarget: string;
  linkType: ReaderDashboardPromoLinkType;
  readChapterSlug?: string | null;
  subtitle?: string | null;
  title: string;
};

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

const BADGE_TYPES = new Set<ReaderDashboardPromoBadgeType>([
  "events",
  "sale",
  "spotlight",
  "default",
]);

function asNonEmptyString(v: unknown): string | null {
  if (typeof v !== "string") {
    return null;
  }
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function normalizeSlide(item: unknown): ReaderDashboardPromoSlide | null {
  if (!item || typeof item !== "object") {
    return null;
  }
  const o = item as Record<string, unknown>;
  const id = asNonEmptyString(o.id);
  const imageUrl = asNonEmptyString(o.imageUrl);
  const title = asNonEmptyString(o.title);
  const linkTypeRaw = asNonEmptyString(o.linkType);
  const linkTarget = asNonEmptyString(o.linkTarget);
  if (!id || !imageUrl || !title || !linkTypeRaw || !linkTarget) {
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

  let badgeType: ReaderDashboardPromoBadgeType | null = null;
  const bt = asNonEmptyString(o.badgeType);
  if (bt && BADGE_TYPES.has(bt as ReaderDashboardPromoBadgeType)) {
    badgeType = bt as ReaderDashboardPromoBadgeType;
  }

  const readChapterSlug = asNonEmptyString(o.readChapterSlug);

  return {
    id,
    imageUrl,
    title,
    subtitle: asNonEmptyString(o.subtitle),
    badgeText: asNonEmptyString(o.badgeText),
    badgeType,
    cardCtaText: asNonEmptyString(o.cardCtaText),
    linkType,
    linkTarget,
    readChapterSlug: readChapterSlug ?? null,
  };
}

export function parsePromoCarouselFromEnv(): ReaderDashboardPromoSlide[] {
  const raw = process.env.READER_DASHBOARD_PROMO_CAROUSEL_JSON;
  if (!raw?.trim()) {
    return [];
  }
  try {
    const data = JSON.parse(raw) as unknown;
    if (!Array.isArray(data)) {
      return [];
    }
    const out: ReaderDashboardPromoSlide[] = [];
    for (const item of data) {
      const slide = normalizeSlide(item);
      if (slide) {
        out.push(slide);
      }
    }
    return out;
  } catch {
    return [];
  }
}

export type FeaturedStoryPromoInput = {
  bannerImage: string;
  shortSynopsis: string;
  slug: string;
  title: string;
};

export function buildDashboardPromoCarousel(
  fromEnv: ReaderDashboardPromoSlide[],
  featured: FeaturedStoryPromoInput | null,
): ReaderDashboardPromoSlide[] {
  if (fromEnv.length > 0) {
    return fromEnv;
  }
  if (!featured) {
    return [];
  }
  return [
    {
      id: "featured-story",
      imageUrl: featured.bannerImage,
      title: featured.title,
      subtitle:
        featured.shortSynopsis?.trim().slice(0, 120) ||
        "Staff pick — start reading today.",
      badgeText: "Featured",
      badgeType: "spotlight",
      cardCtaText: "Read",
      linkType: "story",
      linkTarget: featured.slug,
    },
  ];
}
