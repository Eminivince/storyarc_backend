import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import {
  AdminBookReleaseMode,
  AdminBookVisibilityState,
  AdminSettingKind,
} from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { AdminAuditService, AdminRequestContext } from "../admin-audit.service";
import {
  AdminBookStoryRecord,
  AdminListPagination,
  defaultAdminSettings,
} from "../admin-constants";
import {
  buildAdminPageInfo,
  buildBookInternalId,
  formatCompactNumber,
  formatCurrency,
  formatDate,
  getPercentWidth,
  resolveAdminListLimit,
  slugToLabel,
  getDisplayName,
} from "../admin-format.utils";
import {
  defaultBookPlatformPolicy,
  formatPremiumWindowLabel,
  formatReleaseModeLabel,
  formatVisibilityLabel,
  getStoryVisibilityState,
  normalizeConfiguredPremiumWindowHours,
  resolveEffectiveChapterAccess,
} from "../../utils/book-admin";
import { WebsocketService } from "../../websocket/websocket.service";

@Injectable()
export class AdminBooksService {
  private readonly logger = new Logger(AdminBooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
    private readonly websocketService: WebsocketService,
  ) {}

  private async getAdminUser(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("User not found.");
    return user;
  }

  private async requireAdmin(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.status !== "ACTIVE")
      throw new NotFoundException("User not found.");
    if (user.role !== "ADMIN")
      throw new ForbiddenException("Admin access is required.");
    return user;
  }

  // ---------------------------------------------------------------------------
  // Public methods
  // ---------------------------------------------------------------------------

  async listAdminBooks(
    adminUserId: string,
    pagination: AdminListPagination = {},
  ) {
    // eslint-disable-next-line no-console
    console.log("[admin/books] listAdminBooks called", {
      adminUserId,
      pagination,
    });

    await this.ensureAdminDefaults();
    const policy = await this.ensureBookPlatformDefaults();
    const { stories, hasMore, limit, offset } =
      await this.getAdminBookStories(undefined, pagination);

    // eslint-disable-next-line no-console
    console.log("[admin/books] fetched stories", {
      count: stories.length,
      hasMore,
      limit,
      offset,
    });

    const revenueByStoryId = await this.getBookRevenueMap(
      stories.map((story) => story.id),
    );

    return {
      inventory: stories.map((story) =>
        this.mapAdminBookInventoryItem(
          story,
          revenueByStoryId.get(story.id) ?? 0,
        ),
      ),
      inventoryStats: this.buildAdminBookStats(stories, revenueByStoryId),
      pageInfo: buildAdminPageInfo(limit, offset, hasMore),
      policy: {
        defaultCoinCap: policy.defaultCoinCap,
        defaultPremiumWindowHours: policy.defaultPremiumWindowHours,
        defaultReleaseMode: policy.defaultReleaseMode,
        defaultReleaseModeLabel: formatReleaseModeLabel(
          policy.defaultReleaseMode,
        ),
      },
    };
  }

  async getAdminBookDetails(adminUserId: string, storySlug: string) {
    await this.ensureAdminDefaults();
    const policy = await this.ensureBookPlatformDefaults();
    const story = await this.getAdminBookStoryOrThrow(storySlug);
    const revenueByStoryId = await this.getBookRevenueMap([story.id]);

    return {
      book: this.mapAdminBookDetail(
        story,
        policy,
        revenueByStoryId.get(story.id) ?? 0,
      ),
    };
  }

  async updateAdminBookPolicy(
    adminUserId: string,
    input: {
      defaultCoinCap: number;
      defaultPremiumWindowHours: number;
      defaultReleaseMode: AdminBookReleaseMode;
    },
    ctx?: AdminRequestContext,
  ) {
    const admin = await this.getAdminUser(adminUserId);
    const policy = await this.prisma.bookPlatformPolicy.upsert({
      where: {
        key: defaultBookPlatformPolicy.key,
      },
      create: {
        defaultCoinCap: input.defaultCoinCap,
        defaultPremiumWindowHours: input.defaultPremiumWindowHours,
        defaultReleaseMode: input.defaultReleaseMode,
        key: defaultBookPlatformPolicy.key,
      },
      update: {
        defaultCoinCap: input.defaultCoinCap,
        defaultPremiumWindowHours: input.defaultPremiumWindowHours,
        defaultReleaseMode: input.defaultReleaseMode,
      },
    });

    await this.audit.log(
      admin.id,
      {
        detail: `Updated platform book defaults to ${policy.defaultCoinCap} coins and ${formatPremiumWindowLabel(policy.defaultPremiumWindowHours)}.`,
        icon: "tune",
        summary: "Updated book platform policy",
        targetId: policy.id,
        targetType: "BOOK_POLICY",
      },
      ctx,
    );

    return {
      message: "Book platform policy saved.",
      policy: {
        defaultCoinCap: policy.defaultCoinCap,
        defaultPremiumWindowHours: policy.defaultPremiumWindowHours,
        defaultReleaseMode: policy.defaultReleaseMode,
        defaultReleaseModeLabel: formatReleaseModeLabel(
          policy.defaultReleaseMode,
        ),
      },
    };
  }

  async updateAdminBookVisibility(
    adminUserId: string,
    storySlug: string,
    input: {
      reviewNotes: string | null;
      visibilityState: AdminBookVisibilityState;
    },
    ctx?: AdminRequestContext,
  ) {
    const admin = await this.getAdminUser(adminUserId);
    const policy = await this.ensureBookPlatformDefaults();
    const story = await this.getAdminBookStoryOrThrow(storySlug);
    const nextControl = await this.prisma.storyAdminControl.upsert({
      where: {
        storyId: story.id,
      },
      create: {
        defaultPremiumWindowHours:
          story.adminControl?.defaultPremiumWindowHours ??
          policy.defaultPremiumWindowHours,
        globalCoinCap:
          story.adminControl?.globalCoinCap ?? policy.defaultCoinCap,
        lastUpdatedByAdminUserId: admin.id,
        releaseMode:
          story.adminControl?.releaseMode ?? policy.defaultReleaseMode,
        reviewNotes: input.reviewNotes,
        reviewedAt: new Date(),
        reviewedByAdminUserId: admin.id,
        storyId: story.id,
        visibilityState: input.visibilityState,
      },
      update: {
        lastUpdatedByAdminUserId: admin.id,
        reviewNotes: input.reviewNotes,
        reviewedAt: new Date(),
        reviewedByAdminUserId: admin.id,
        visibilityState: input.visibilityState,
      },
    });

    await this.prisma.story.update({
      where: {
        id: story.id,
      },
      data: {
        isLive: input.visibilityState === AdminBookVisibilityState.LIVE,
        liveAt:
          input.visibilityState === AdminBookVisibilityState.LIVE
            ? new Date()
            : null,
      },
    });

    await this.audit.log(
      admin.id,
      {
        detail: `${story.title} is now ${formatVisibilityLabel(nextControl.visibilityState).toLowerCase()}.`,
        icon:
          nextControl.visibilityState === AdminBookVisibilityState.LIVE
            ? "visibility"
            : nextControl.visibilityState === AdminBookVisibilityState.HIDDEN
              ? "visibility_off"
              : "pending",
        summary: `Updated ${story.title} visibility`,
        targetId: story.id,
        targetType: "BOOK",
        tone:
          nextControl.visibilityState === AdminBookVisibilityState.HIDDEN
            ? "rose"
            : nextControl.visibilityState === AdminBookVisibilityState.LIVE
              ? "emerald"
              : "amber",
      },
      ctx,
    );

    return {
      message: `${story.title} is now ${formatVisibilityLabel(nextControl.visibilityState).toLowerCase()}.`,
      visibilityState: nextControl.visibilityState,
    };
  }

  async updateAdminBookConfig(
    adminUserId: string,
    storySlug: string,
    input: {
      chapters: Array<{
        coinPriceOverride: number | null;
        lockedOverride: boolean | null;
        overrideEnabled: boolean;
        premiumWindowHoursOverride: number | null;
        publishedChapterId: string;
      }>;
      defaultPremiumWindowHours: number;
      globalCoinCap: number;
      reviewNotes: string | null;
      visibilityState: AdminBookVisibilityState | null;
    },
    ctx?: AdminRequestContext,
  ) {
    const admin = await this.getAdminUser(adminUserId);
    const policy = await this.ensureBookPlatformDefaults();
    const story = await this.getAdminBookStoryOrThrow(storySlug);
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.storyAdminControl.upsert({
        where: {
          storyId: story.id,
        },
        create: {
          defaultPremiumWindowHours: input.defaultPremiumWindowHours,
          globalCoinCap: input.globalCoinCap,
          lastUpdatedByAdminUserId: admin.id,
          releaseMode:
            story.adminControl?.releaseMode ?? policy.defaultReleaseMode,
          reviewNotes: input.reviewNotes,
          reviewedAt: input.visibilityState
            ? now
            : (story.adminControl?.reviewedAt ?? null),
          reviewedByAdminUserId: input.visibilityState
            ? admin.id
            : (story.adminControl?.reviewedByAdminUserId ?? null),
          storyId: story.id,
          visibilityState:
            input.visibilityState ??
            story.adminControl?.visibilityState ??
            getStoryVisibilityState(story),
        },
        update: {
          defaultPremiumWindowHours: input.defaultPremiumWindowHours,
          globalCoinCap: input.globalCoinCap,
          lastUpdatedByAdminUserId: admin.id,
          reviewNotes: input.reviewNotes,
          reviewedAt: input.visibilityState
            ? now
            : (story.adminControl?.reviewedAt ?? null),
          reviewedByAdminUserId: input.visibilityState
            ? admin.id
            : (story.adminControl?.reviewedByAdminUserId ?? null),
          visibilityState:
            input.visibilityState ?? story.adminControl?.visibilityState,
        },
      });

      for (const chapterInput of input.chapters) {
        const publishedChapter = story.publishedChapters.find(
          (chapter) => chapter.id === chapterInput.publishedChapterId,
        );

        if (!publishedChapter) {
          throw new NotFoundException("Published chapter not found.");
        }

        await tx.publishedChapterAdminOverride.upsert({
          where: {
            publishedChapterId: publishedChapter.id,
          },
          create: {
            coinPriceOverride: chapterInput.overrideEnabled
              ? chapterInput.coinPriceOverride
              : null,
            lockedOverride: chapterInput.overrideEnabled
              ? chapterInput.lockedOverride
              : null,
            overrideEnabled: chapterInput.overrideEnabled,
            premiumWindowHoursOverride: chapterInput.overrideEnabled
              ? chapterInput.premiumWindowHoursOverride
              : null,
            publishedChapterId: publishedChapter.id,
            updatedByAdminUserId: admin.id,
          },
          update: {
            coinPriceOverride: chapterInput.overrideEnabled
              ? chapterInput.coinPriceOverride
              : null,
            lockedOverride: chapterInput.overrideEnabled
              ? chapterInput.lockedOverride
              : null,
            overrideEnabled: chapterInput.overrideEnabled,
            premiumWindowHoursOverride: chapterInput.overrideEnabled
              ? chapterInput.premiumWindowHoursOverride
              : null,
            updatedByAdminUserId: admin.id,
          },
        });
      }
    });

    if (input.visibilityState) {
      await this.prisma.story.update({
        where: {
          id: story.id,
        },
        data: {
          isLive: input.visibilityState === AdminBookVisibilityState.LIVE,
          liveAt:
            input.visibilityState === AdminBookVisibilityState.LIVE
              ? now
              : null,
        },
      });
    }

    await this.audit.log(
      admin.id,
      {
        detail: `Saved admin release controls for ${story.title}.`,
        icon: "settings_suggest",
        summary: `Saved ${story.title} book controls`,
        targetId: story.id,
        targetType: "BOOK",
      },
      ctx,
    );

    return {
      book: await this.getAdminBookDetails(adminUserId, storySlug).then(
        (response) => response.book,
      ),
      message: `${story.title} controls saved.`,
    };
  }

  async getWeeklyFeaturedStories(adminUserId: string) {

    const stories = await this.prisma.story.findMany({
      where: { featured: true, isLive: true },
      include: { assets: true, author: { include: { profile: true } } },
      orderBy: { totalReads: "desc" },
      take: 20,
    });

    return {
      stories: stories.map((s) => ({
        slug: s.slug,
        title: s.title,
        coverImage: s.assets?.coverImageUrl ?? null,
        authorName: s.author?.profile?.displayName ?? "Unknown",
        totalReads: s.totalReads,
        averageRating: s.averageRating,
        status: s.status,
        featuredAt: s.updatedAt,
      })),
    };
  }

  async setWeeklyFeaturedStories(
    adminUserId: string,
    slugs: string[],
    ctx?: AdminRequestContext,
  ) {
    const admin = await this.getAdminUser(adminUserId);

    await this.prisma.story.updateMany({
      where: { featured: true },
      data: { featured: false },
    });

    if (slugs.length > 0) {
      await this.prisma.story.updateMany({
        where: { slug: { in: slugs }, isLive: true },
        data: { featured: true },
      });
    }

    this.logger.log({
      event: "WEEKLY_FEATURED_SET",
      adminUserId,
      slugCount: slugs.length,
    });

    this.websocketService.broadcast("featured:updated", {});
    return { message: `${slugs.length} stories set as weekly featured.` };
  }

  async removeWeeklyFeaturedStory(
    adminUserId: string,
    storySlug: string,
    ctx?: AdminRequestContext,
  ) {

    await this.prisma.story.updateMany({
      where: { slug: storySlug },
      data: { featured: false },
    });

    this.logger.log({
      event: "WEEKLY_FEATURED_REMOVED",
      adminUserId,
      storySlug,
    });

    this.websocketService.broadcast("featured:updated", {});
    return { message: "Story removed from weekly featured." };
  }

  // ---------------------------------------------------------------------------
  // Promo Carousel
  // ---------------------------------------------------------------------------

  async getPromoCarouselSlides() {
    const slides = await this.prisma.promoSlide.findMany({
      orderBy: { sortOrder: "asc" },
    });
    return { slides };
  }

  async replacePromoCarouselSlides(
    slides: Array<{
      imageUrl: string;
      title: string;
      subtitle?: string | null;
      badgeText?: string | null;
      badgeType?: string | null;
      cardCtaText?: string | null;
      linkType: string;
      linkTarget: string;
      readChapterSlug?: string | null;
      sortOrder?: number;
      isActive?: boolean;
    }>,
  ) {
    await this.prisma.$transaction(async (tx) => {
      await tx.promoSlide.deleteMany({});
      if (slides.length > 0) {
        await tx.promoSlide.createMany({
          data: slides.map((slide, index) => ({
            imageUrl: slide.imageUrl,
            title: slide.title,
            subtitle: slide.subtitle ?? null,
            badgeText: slide.badgeText ?? null,
            badgeType: slide.badgeType ?? null,
            cardCtaText: slide.cardCtaText ?? null,
            linkType: slide.linkType,
            linkTarget: slide.linkTarget,
            readChapterSlug: slide.readChapterSlug ?? null,
            sortOrder: slide.sortOrder ?? index,
            isActive: slide.isActive ?? true,
          })),
        });
      }
    });

    this.logger.log({ event: "PROMO_CAROUSEL_REPLACED", slideCount: slides.length });
    this.websocketService.broadcast("promo:updated", {});
    return { message: `${slides.length} promo slides saved.` };
  }

  // ---------------------------------------------------------------------------
  // Limited Offers
  // ---------------------------------------------------------------------------

  private static readonly LIMITED_OFFERS_MAX = 6;

  async getLimitedOffers() {
    const offers = await this.prisma.limitedOffer.findMany({
      orderBy: { sortOrder: "asc" },
      include: {
        story: {
          select: {
            title: true,
            slug: true,
            assets: { select: { coverImageUrl: true } },
          },
        },
      },
    });

    return {
      offers: offers.map((offer) => ({
        id: offer.id,
        storyId: offer.storyId,
        discountLabel: offer.discountLabel,
        startsAt: offer.startsAt,
        endsAt: offer.endsAt,
        sortOrder: offer.sortOrder,
        isActive: offer.isActive,
        createdAt: offer.createdAt,
        story: {
          title: offer.story.title,
          slug: offer.story.slug,
          coverImageUrl: offer.story.assets?.coverImageUrl ?? null,
        },
      })),
    };
  }

  async createLimitedOffer(input: {
    storyId: string;
    discountLabel: string;
    startsAt: Date;
    endsAt: Date;
  }) {
    const existingCount = await this.prisma.limitedOffer.count();
    if (existingCount >= AdminBooksService.LIMITED_OFFERS_MAX) {
      throw new BadRequestException(
        `Maximum of ${AdminBooksService.LIMITED_OFFERS_MAX} limited offers. Delete one before adding another.`,
      );
    }

    const story = await this.prisma.story.findUnique({ where: { id: input.storyId } });
    if (!story) throw new NotFoundException("Story not found.");

    const offer = await this.prisma.limitedOffer.create({
      data: {
        storyId: input.storyId,
        discountLabel: input.discountLabel,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
      },
    });

    this.logger.log({ event: "LIMITED_OFFER_CREATED", offerId: offer.id, storyId: input.storyId });
    this.websocketService.broadcast("offers:updated", {});
    return { message: "Limited offer created.", offer };
  }

  async deleteLimitedOffer(offerId: string) {
    await this.prisma.limitedOffer.delete({ where: { id: offerId } }).catch(() => {
      throw new NotFoundException("Limited offer not found.");
    });

    this.logger.log({ event: "LIMITED_OFFER_DELETED", offerId });
    this.websocketService.broadcast("offers:updated", {});
    return { message: "Limited offer deleted." };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async ensureAdminDefaults() {
    for (const setting of defaultAdminSettings) {
      await this.prisma.adminSetting.upsert({
        where: {
          key: setting.key,
        },
        create: setting,
        update: {
          description: setting.description,
          group: setting.group,
          kind: setting.kind,
          title: setting.title,
          valueCents:
            setting.kind === AdminSettingKind.BOOLEAN ? null : undefined,
        },
      });
    }
  }

  private async ensureBookPlatformDefaults() {
    const policy = await this.prisma.bookPlatformPolicy.upsert({
      where: {
        key: defaultBookPlatformPolicy.key,
      },
      create: {
        defaultCoinCap: defaultBookPlatformPolicy.defaultCoinCap,
        defaultPremiumWindowHours:
          defaultBookPlatformPolicy.defaultPremiumWindowHours,
        defaultReleaseMode: defaultBookPlatformPolicy.defaultReleaseMode,
        key: defaultBookPlatformPolicy.key,
      },
      update: {},
    });

    if (policy.defaultPremiumWindowHours === 72) {
      return this.prisma.bookPlatformPolicy.update({
        where: {
          id: policy.id,
        },
        data: {
          defaultPremiumWindowHours:
            defaultBookPlatformPolicy.defaultPremiumWindowHours,
        },
      });
    }

    return policy;
  }

  private async getAdminBookStories(
    storySlug?: string,
    pagination?: AdminListPagination,
  ): Promise<{
    hasMore: boolean;
    limit: number;
    offset: number;
    stories: AdminBookStoryRecord[];
  }> {
    const policy = await this.ensureBookPlatformDefaults();
    const limit = resolveAdminListLimit(pagination?.limit);
    const offset = pagination?.offset ?? 0;

    const stories = await this.prisma.story.findMany({
      where: storySlug
        ? {
            slug: storySlug,
          }
        : {
            publishedChapters: {
              some: {},
            },
          },
      include: {
        adminControl: true,
        assets: true,
        author: {
          include: {
            profile: true,
          },
        },
        contentReports: {
          where: {
            status: {
              in: ["OPEN", "IN_REVIEW"],
            },
          },
        },
        publishedChapters: {
          include: {
            adminOverride: true,
            chapter: true,
          },
          orderBy: {
            chapterNumber: "asc",
          },
        },
      },
      orderBy: [
        {
          updatedAt: "desc",
        },
        {
          title: "asc",
        },
      ],
      skip: storySlug ? 0 : offset,
      take: storySlug ? undefined : limit + 1,
    });

    const hasMore = !storySlug && stories.length > limit;
    const slicedStories =
      !storySlug && hasMore ? stories.slice(0, limit) : stories;

    const storiesMissingControl = slicedStories.filter(
      (story) => !story.adminControl,
    );

    if (storiesMissingControl.length > 0) {
      await Promise.all(
        storiesMissingControl.map((story) =>
          this.prisma.storyAdminControl.upsert({
            where: {
              storyId: story.id,
            },
            create: {
              defaultPremiumWindowHours: policy.defaultPremiumWindowHours,
              globalCoinCap: policy.defaultCoinCap,
              releaseMode: policy.defaultReleaseMode,
              reviewedAt:
                story.isLive || story.liveAt
                  ? (story.liveAt ?? story.publishedAt ?? new Date())
                  : null,
              storyId: story.id,
              visibilityState: story.isLive
                ? AdminBookVisibilityState.LIVE
                : AdminBookVisibilityState.PENDING_APPROVAL,
            },
            update: {},
          }),
        ),
      );

      return this.getAdminBookStories(storySlug, pagination);
    }

    return {
      hasMore,
      limit,
      offset,
      stories: slicedStories,
    };
  }

  private async getAdminBookStoryOrThrow(
    storySlug: string,
  ): Promise<AdminBookStoryRecord> {
    const { stories } = await this.getAdminBookStories(storySlug);
    const story = stories[0];

    if (!story) {
      throw new NotFoundException("Book not found.");
    }

    return story;
  }

  private async getBookRevenueMap(storyIds: string[]) {
    if (storyIds.length === 0) {
      return new Map<string, number>();
    }

    const entries = await this.prisma.walletLedgerEntry.findMany({
      where: {
        reason: {
          in: ["CHAPTER_UNLOCK", "GIFT_SENT"],
        },
        storyId: {
          in: storyIds,
        },
      },
      select: {
        deltaCoins: true,
        storyId: true,
      },
    });

    return entries.reduce((map, entry) => {
      if (!entry.storyId) {
        return map;
      }

      map.set(
        entry.storyId,
        (map.get(entry.storyId) ?? 0) + Math.abs(entry.deltaCoins) * 100,
      );
      return map;
    }, new Map<string, number>());
  }

  private buildAdminBookStats(
    stories: AdminBookStoryRecord[],
    revenueByStoryId: Map<string, number>,
  ) {
    const totalBooks = stories.length;
    const liveBooks = stories.filter(
      (story) =>
        getStoryVisibilityState(story) === AdminBookVisibilityState.LIVE,
    ).length;
    const pendingBooks = stories.filter(
      (story) =>
        getStoryVisibilityState(story) ===
        AdminBookVisibilityState.PENDING_APPROVAL,
    ).length;
    const flaggedBooks = stories.filter(
      (story) => story.contentReports.length > 0,
    ).length;
    const totalRevenueCents = Array.from(revenueByStoryId.values()).reduce(
      (sum, value) => sum + value,
      0,
    );

    return [
      {
        delta: `${flaggedBooks} flagged`,
        id: "total-books",
        label: "Total Books",
        value: formatCompactNumber(totalBooks),
        width: "100%",
      },
      {
        delta: `${getPercentWidth(liveBooks, Math.max(totalBooks, 1)).toFixed(0)}% live`,
        id: "live-books",
        label: "Live Books",
        value: formatCompactNumber(liveBooks),
        width: `${getPercentWidth(liveBooks, Math.max(totalBooks, 1))}%`,
      },
      {
        delta: `${flaggedBooks} flagged`,
        id: "pending-approval",
        label: "Pending Approval",
        value: formatCompactNumber(pendingBooks),
        width: `${getPercentWidth(pendingBooks, Math.max(totalBooks, 1))}%`,
      },
      {
        delta: `${stories.reduce((sum, story) => sum + story.totalReads, 0)} reads`,
        id: "total-revenue",
        label: "Tracked Revenue",
        value: formatCurrency(totalRevenueCents),
        width:
          totalRevenueCents > 0
            ? `${Math.min(100, 30 + Math.log10(totalRevenueCents) * 18)}%`
            : "12%",
      },
    ];
  }

  private mapAdminBookInventoryItem(
    story: AdminBookStoryRecord,
    revenueCents: number,
  ) {
    const visibilityState = getStoryVisibilityState(story);
    const firstGenre = story.genreSlugs[0] ?? "story";

    return {
      author: story.author
        ? getDisplayName(story.author)
        : story.authorName,
      authorLockSummary: this.buildAuthorLockSummary(story),
      cover:
        story.assets?.coverImageUrl ??
        story.assets?.cardImageUrl ??
        story.assets?.bannerImageUrl ??
        "",
      flagged: story.contentReports.length > 0,
      genre: slugToLabel(firstGenre),
      id: story.slug,
      internalId: `BK-${buildBookInternalId(story.id)}`,
      lockPolicy: formatReleaseModeLabel(
        story.adminControl?.releaseMode ?? AdminBookReleaseMode.PREMIUM_WINDOW,
      ),
      publishedAt: story.publishedAt
        ? formatDate(story.publishedAt)
        : "Draft",
      revenue: formatCurrency(revenueCents),
      status: formatVisibilityLabel(visibilityState),
      title: story.title,
      trendTag: story.featured ? "Featured" : null,
      visibility:
        visibilityState === AdminBookVisibilityState.LIVE
          ? "Public"
          : "Private",
    };
  }

  private mapAdminBookDetail(
    story: AdminBookStoryRecord,
    policy: {
      defaultCoinCap: number;
      defaultPremiumWindowHours: number;
      defaultReleaseMode: AdminBookReleaseMode;
    },
    revenueCents: number,
  ) {
    const visibilityState = getStoryVisibilityState(story);
    const defaultPremiumWindowHours = normalizeConfiguredPremiumWindowHours(
      story.adminControl?.defaultPremiumWindowHours,
      story.adminControl?.lastUpdatedByAdminUserId ?? null,
    );
    const storyControl = {
      defaultPremiumWindowHours,
      globalCoinCap:
        story.adminControl?.globalCoinCap ?? policy.defaultCoinCap,
      releaseMode:
        story.adminControl?.releaseMode ?? policy.defaultReleaseMode,
      reviewNotes: story.adminControl?.reviewNotes ?? null,
    };

    return {
      chapterCount: story.publishedChapters.length,
      chapters: story.publishedChapters.map((chapter) =>
        this.mapAdminBookChapter(
          chapter,
          storyControl,
          story.liveAt ?? null,
        ),
      ),
      cover:
        story.assets?.coverImageUrl ??
        story.assets?.cardImageUrl ??
        story.assets?.bannerImageUrl ??
        "",
      genre: slugToLabel(story.genreSlugs[0] ?? "story"),
      globalCoinCap: storyControl.globalCoinCap,
      globalLockWindow: formatPremiumWindowLabel(defaultPremiumWindowHours),
      globalLockWindowHours: defaultPremiumWindowHours,
      id: story.slug,
      releaseMode: storyControl.releaseMode,
      releaseModeLabel: formatReleaseModeLabel(storyControl.releaseMode),
      revenue: formatCurrency(revenueCents),
      reviewNotes: storyControl.reviewNotes ?? "",
      status: formatVisibilityLabel(visibilityState),
      subtitle: `Internal ID: BK-${buildBookInternalId(story.id)}`,
      title: story.title,
      visibilityMode: visibilityState,
    };
  }

  private mapAdminBookChapter(
    chapter: AdminBookStoryRecord["publishedChapters"][number],
    storyControl: {
      defaultPremiumWindowHours: number;
      globalCoinCap: number;
    },
    storyLiveAt: Date | null,
  ) {
    const overrideEnabled = chapter.adminOverride?.overrideEnabled ?? false;
    const authorLocked =
      chapter.chapter.premiumEnabled && chapter.chapter.coinUnlockPrice > 0;
    const configuredCoinPrice = overrideEnabled
      ? (chapter.adminOverride?.coinPriceOverride ??
        (authorLocked
          ? Math.min(
              chapter.chapter.coinUnlockPrice,
              storyControl.globalCoinCap > 0
                ? storyControl.globalCoinCap
                : chapter.chapter.coinUnlockPrice,
            )
          : 0))
      : authorLocked
        ? chapter.chapter.coinUnlockPrice
        : 0;
    const configuredLockWindowHours =
      overrideEnabled &&
      chapter.adminOverride?.premiumWindowHoursOverride !== null &&
      chapter.adminOverride?.premiumWindowHoursOverride !== undefined
        ? chapter.adminOverride.premiumWindowHoursOverride
        : storyControl.defaultPremiumWindowHours;
    const configuredLocked = overrideEnabled
      ? (chapter.adminOverride?.lockedOverride ?? configuredCoinPrice > 0)
      : authorLocked;
    const effective = resolveEffectiveChapterAccess({
      adminOverride: chapter.adminOverride,
      authorCoinUnlockPrice: chapter.chapter.coinUnlockPrice,
      authorPremiumEnabled: chapter.chapter.premiumEnabled,
      globalCoinCap: storyControl.globalCoinCap,
      lockConfiguredAt: chapter.adminOverride?.updatedAt ?? null,
      premiumWindowHours: storyControl.defaultPremiumWindowHours,
      publishedAt: chapter.publishedAt,
      storyLiveAt,
    });
    const authorLockLabel = authorLocked
      ? `Locked (${chapter.chapter.coinUnlockPrice} Coins)`
      : "Free";
    const effectiveLockLabel = effective.isCurrentlyPremium
      ? effective.unlocksAt
        ? `Locked now • unlocks ${formatDate(effective.unlocksAt)}`
        : `Locked now • ${effective.effectiveCoinPrice} coins`
      : effective.windowExpired
        ? "Free now • premium window expired"
        : "Free now";

    return {
      adminLocked: configuredLocked,
      adminOverrideEnabled: overrideEnabled,
      authorDefaultCoinPrice: authorLocked
        ? chapter.chapter.coinUnlockPrice
        : 0,
      authorDefaultLockWindow: formatPremiumWindowLabel(
        storyControl.defaultPremiumWindowHours,
      ),
      authorDefaultLockWindowHours: storyControl.defaultPremiumWindowHours,
      authorLockLabel,
      authorLockState: authorLocked ? "locked" : "free",
      coinPrice: configuredCoinPrice,
      effectiveCoinPrice: effective.effectiveCoinPrice,
      effectiveLockLabel,
      effectiveLockState: effective.isCurrentlyPremium ? "locked" : "free",
      id: chapter.id,
      lockWindow: formatPremiumWindowLabel(configuredLockWindowHours),
      lockWindowHours: configuredLockWindowHours,
      publishedAt: `Published ${formatDate(chapter.publishedAt)}`,
      title: `Ch. ${chapter.chapterNumber}: ${chapter.title}`,
    };
  }

  private buildAuthorLockSummary(story: AdminBookStoryRecord) {
    const lockedChapters = story.publishedChapters.filter(
      (chapter) =>
        chapter.chapter.premiumEnabled && chapter.chapter.coinUnlockPrice > 0,
    );

    if (lockedChapters.length === 0) {
      return "Author: All chapters free";
    }

    const maxPrice = lockedChapters.reduce(
      (highest, chapter) =>
        chapter.chapter.coinUnlockPrice > highest
          ? chapter.chapter.coinUnlockPrice
          : highest,
      0,
    );

    if (lockedChapters.length === story.publishedChapters.length) {
      return `Author: Fully locked (${maxPrice}C)`;
    }

    const firstLocked = lockedChapters[0]?.chapterNumber ?? 1;
    const lastLocked =
      lockedChapters[lockedChapters.length - 1]?.chapterNumber ?? firstLocked;

    return `Author: Ch. ${firstLocked}-${lastLocked} locked (${maxPrice}C)`;
  }
}
