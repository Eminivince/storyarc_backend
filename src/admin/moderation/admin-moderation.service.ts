import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { CommentStatus, ReviewStatus } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import {
  AdminAuditService,
  AdminRequestContext,
} from "../admin-audit.service";
import { AdminListPagination } from "../admin-constants";
import {
  buildAdminPageInfo,
  formatRelativeDate,
  getAvatarUrl,
  getDisplayName,
  mapAdminCommentStatus,
  mapAdminReviewStatus,
  mapReportStatusLabel,
  resolveAdminListLimit,
  truncateCopy,
} from "../admin-format.utils";

@Injectable()
export class AdminModerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
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

  // --- Reports ---

  async listAdminReports(
    adminUserId: string,
    pagination: AdminListPagination = {},
  ) {

    const limit = resolveAdminListLimit(pagination.limit);
    const offset = pagination.offset ?? 0;
    const reports = await this.prisma.contentReport.findMany({
      include: {
        reporter: {
          include: {
            profile: true,
          },
        },
        story: true,
        chapter: true,
      },
      orderBy: {
        createdAt: "desc",
      },
      skip: offset,
      take: limit + 1,
    });
    const hasMore = reports.length > limit;
    const slicedReports = hasMore ? reports.slice(0, limit) : reports;

    return {
      reports: slicedReports.map((report) =>
        this.mapReport(report, report.story, report.chapter, report.reporter),
      ),
      pageInfo: buildAdminPageInfo(limit, offset, hasMore),
    };
  }

  async resolveAdminReport(
    adminUserId: string,
    reportId: string,
    input: {
      action: "RESOLVED" | "TAKEDOWN" | "DISMISSED" | "IN_REVIEW";
      notes: string | null;
    },
    context?: AdminRequestContext,
  ) {
    const admin = await this.getAdminUser(adminUserId);
    const report = await this.prisma.contentReport.findUnique({
      where: {
        id: reportId,
      },
      include: {
        reporter: {
          include: {
            profile: true,
          },
        },
        story: true,
        chapter: true,
      },
    });

    if (!report) {
      throw new NotFoundException("Report not found.");
    }

    const updatedReport = await this.prisma.contentReport.update({
      where: {
        id: reportId,
      },
      data: {
        assignedAdminId: admin.id,
        resolutionNotes: input.notes,
        status: input.action,
      },
      include: {
        reporter: {
          include: {
            profile: true,
          },
        },
        story: true,
        chapter: true,
      },
    });

    await this.audit.log(
      admin.id,
      {
        detail: `${updatedReport.title} was marked ${mapReportStatusLabel(input.action).toLowerCase()}.`,
        icon: input.action === "TAKEDOWN" ? "delete" : "gavel",
        summary: `${mapReportStatusLabel(input.action)} moderation item`,
        targetId: reportId,
        targetType: "REPORT",
        tone: input.action === "TAKEDOWN" ? "rose" : "emerald",
      },
      context,
    );

    return {
      message: `${updatedReport.title} marked as ${mapReportStatusLabel(input.action).toLowerCase()}.`,
      report: this.mapReport(
        updatedReport,
        updatedReport.story,
        updatedReport.chapter,
        updatedReport.reporter,
      ),
    };
  }

  // --- Comments ---

  async listAdminComments(
    adminUserId: string,
    pagination: AdminListPagination = {},
  ) {

    const limit = resolveAdminListLimit(pagination.limit);
    const offset = pagination.offset ?? 0;
    const comments = await this.prisma.comment.findMany({
      include: {
        chapter: true,
        parent: {
          include: {
            user: {
              include: {
                profile: true,
              },
            },
          },
        },
        story: true,
        user: {
          include: {
            profile: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
      skip: offset,
      take: limit + 1,
    });
    const hasMore = comments.length > limit;
    const slicedComments = hasMore ? comments.slice(0, limit) : comments;

    return {
      comments: slicedComments.map((comment) =>
        this.mapAdminComment(comment),
      ),
      pageInfo: buildAdminPageInfo(limit, offset, hasMore),
      summary: {
        deletedCount: slicedComments.filter(
          (comment) => comment.status === CommentStatus.DELETED,
        ).length,
        hiddenCount: slicedComments.filter(
          (comment) => comment.status === CommentStatus.HIDDEN,
        ).length,
        replyCount: slicedComments.filter((comment) =>
          Boolean(comment.parentCommentId),
        ).length,
        visibleCount: slicedComments.filter(
          (comment) => comment.status === CommentStatus.VISIBLE,
        ).length,
      },
    };
  }

  async moderateAdminComment(
    adminUserId: string,
    commentId: string,
    input: {
      action: "HIDE" | "RESTORE" | "DELETE";
      notes: string | null;
    },
    context?: AdminRequestContext,
  ) {
    const admin = await this.getAdminUser(adminUserId);
    const existingComment = await this.prisma.comment.findUnique({
      where: {
        id: commentId,
      },
      include: {
        chapter: true,
        story: true,
        user: {
          include: {
            profile: true,
          },
        },
      },
    });

    if (!existingComment) {
      throw new NotFoundException("Comment not found.");
    }

    const nextStatus =
      input.action === "RESTORE"
        ? CommentStatus.VISIBLE
        : input.action === "HIDE"
          ? CommentStatus.HIDDEN
          : CommentStatus.DELETED;
    const moderatedComment = await this.prisma.comment.update({
      where: {
        id: commentId,
      },
      data: {
        moderatedAt: new Date(),
        moderatedByAdminUserId: admin.id,
        moderationNotes: input.notes,
        status: nextStatus,
      },
      include: {
        chapter: true,
        parent: {
          include: {
            user: {
              include: {
                profile: true,
              },
            },
          },
        },
        story: true,
        user: {
          include: {
            profile: true,
          },
        },
      },
    });

    await this.audit.log(
      admin.id,
      {
        detail: `${getDisplayName(moderatedComment.user)}'s comment on ${moderatedComment.story.title} was ${nextStatus.toLowerCase()}.`,
        icon:
          input.action === "RESTORE"
            ? "history"
            : input.action === "HIDE"
              ? "visibility_off"
              : "delete",
        summary: `${mapAdminCommentStatus(nextStatus)} comment moderation`,
        targetId: commentId,
        targetType: "COMMENT",
        tone: input.action === "RESTORE" ? "emerald" : "rose",
      },
      context,
    );

    return {
      comment: this.mapAdminComment(moderatedComment),
      message:
        input.action === "RESTORE"
          ? "Comment restored."
          : input.action === "HIDE"
            ? "Comment hidden."
            : "Comment deleted.",
    };
  }

  // --- Reviews ---

  async listAdminReviews(
    adminUserId: string,
    pagination: AdminListPagination = {},
  ) {

    const limit = resolveAdminListLimit(pagination.limit);
    const offset = pagination.offset ?? 0;
    const reviews = await this.prisma.review.findMany({
      include: {
        story: true,
        user: {
          include: {
            profile: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
      skip: offset,
      take: limit + 1,
    });
    const hasMore = reviews.length > limit;
    const slicedReviews = hasMore ? reviews.slice(0, limit) : reviews;

    return {
      reviews: slicedReviews.map((review) => this.mapAdminReview(review)),
      pageInfo: buildAdminPageInfo(limit, offset, hasMore),
      summary: {
        deletedCount: slicedReviews.filter(
          (review) => review.status === ReviewStatus.DELETED,
        ).length,
        hiddenCount: slicedReviews.filter(
          (review) => review.status === ReviewStatus.HIDDEN,
        ).length,
        spoilerCount: slicedReviews.filter((review) => review.containsSpoilers)
          .length,
        visibleCount: slicedReviews.filter(
          (review) => review.status === ReviewStatus.VISIBLE,
        ).length,
      },
    };
  }

  async moderateAdminReview(
    adminUserId: string,
    reviewId: string,
    input: {
      action: "HIDE" | "RESTORE" | "DELETE";
      notes: string | null;
    },
    context?: AdminRequestContext,
  ) {
    const admin = await this.getAdminUser(adminUserId);
    const existingReview = await this.prisma.review.findUnique({
      where: {
        id: reviewId,
      },
      include: {
        story: true,
        user: {
          include: {
            profile: true,
          },
        },
      },
    });

    if (!existingReview) {
      throw new NotFoundException("Review not found.");
    }

    const nextStatus =
      input.action === "RESTORE"
        ? ReviewStatus.VISIBLE
        : input.action === "HIDE"
          ? ReviewStatus.HIDDEN
          : ReviewStatus.DELETED;
    const moderatedReview = await this.prisma.review.update({
      where: {
        id: reviewId,
      },
      data: {
        moderatedAt: new Date(),
        moderatedByAdminUserId: admin.id,
        moderationNotes: input.notes,
        status: nextStatus,
      },
      include: {
        story: true,
        user: {
          include: {
            profile: true,
          },
        },
      },
    });

    await this.audit.log(
      admin.id,
      {
        detail: `${getDisplayName(moderatedReview.user)}'s review on ${moderatedReview.story.title} was ${nextStatus.toLowerCase()}.`,
        icon:
          input.action === "RESTORE"
            ? "history"
            : input.action === "HIDE"
              ? "visibility_off"
              : "delete",
        summary: `${mapAdminReviewStatus(nextStatus)} review moderation`,
        targetId: reviewId,
        targetType: "REVIEW",
        tone: input.action === "RESTORE" ? "emerald" : "rose",
      },
      context,
    );

    return {
      message:
        input.action === "RESTORE"
          ? "Review restored."
          : input.action === "HIDE"
            ? "Review hidden."
            : "Review deleted.",
      review: this.mapAdminReview(moderatedReview),
    };
  }

  // --- Private helpers ---

  private mapReport(report: any, story: any, chapter: any, reporter: any) {
    return {
      detail: report.details ?? report.reason,
      id: report.id,
      image: null,
      primaryAction: "Resolve",
      secondaryAction: "Review",
      severity: report.status === "TAKEDOWN" ? "rose" : "primary",
      status: mapReportStatusLabel(report.status),
      subtitle: `${getDisplayName(reporter)} • ${formatRelativeDate(report.createdAt)}`,
      title:
        report.title ??
        (chapter
          ? `${story?.title ?? report.storySlug} - ${chapter.title}`
          : story?.title ?? report.storySlug),
      type:
        report.targetType === "CHAPTER" ? "Flagged Content" : "Story Report",
    };
  }

  private mapAdminComment(comment: any) {
    return {
      authorAvatarUrl: getAvatarUrl(comment.user),
      authorId: comment.user.id,
      authorName: getDisplayName(comment.user),
      body: comment.body,
      bodyPreview: truncateCopy(comment.body, 220),
      chapterNumber: comment.chapter.chapterNumber,
      chapterSlug: comment.chapter.slug,
      chapterTitle: comment.chapter.title,
      createdAt: comment.createdAt,
      createdAtLabel: formatRelativeDate(comment.createdAt),
      id: comment.id,
      isReply: Boolean(comment.parentCommentId),
      moderationNotes: comment.moderationNotes ?? null,
      moderatedAt: comment.moderatedAt,
      moderatedAtLabel: comment.moderatedAt
        ? formatRelativeDate(comment.moderatedAt)
        : null,
      parentComment: comment.parent
        ? {
            authorName: getDisplayName(comment.parent.user),
            bodyPreview: truncateCopy(comment.parent.body, 120),
            id: comment.parent.id,
            status: mapAdminCommentStatus(comment.parent.status),
          }
        : null,
      readHref: `/read/${comment.story.slug}/${comment.chapter.slug}`,
      status: mapAdminCommentStatus(comment.status),
      storySlug: comment.story.slug,
      storyTitle: comment.story.title,
    };
  }

  private mapAdminReview(review: any) {
    return {
      authorAvatarUrl: getAvatarUrl(review.user),
      authorId: review.user.id,
      authorName: getDisplayName(review.user),
      body: review.body,
      bodyPreview: truncateCopy(review.body, 240),
      containsSpoilers: review.containsSpoilers,
      createdAt: review.createdAt,
      createdAtLabel: formatRelativeDate(review.createdAt),
      id: review.id,
      moderationNotes: review.moderationNotes ?? null,
      moderatedAt: review.moderatedAt,
      moderatedAtLabel: review.moderatedAt
        ? formatRelativeDate(review.moderatedAt)
        : null,
      rating: review.rating,
      readHref: `/stories/${review.story.slug}/reviews`,
      status: mapAdminReviewStatus(review.status),
      storySlug: review.story.slug,
      storyTitle: review.story.title,
      title: review.title ?? null,
    };
  }
}
