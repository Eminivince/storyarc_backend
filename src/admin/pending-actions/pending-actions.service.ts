import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../database/prisma.service";
import { AdminAuditService, type AdminRequestContext } from "../admin-audit.service";
import { getDisplayName } from "../admin-format.utils";

const PENDING_ACTION_EXPIRY_HOURS = 48;

/**
 * Actions that require two-person review.
 * The requesting admin cannot approve their own action.
 */
export const TWO_PERSON_REVIEW_ACTIONS = new Set([
  "user:delete",
  "user:suspend",
  "settings:write",
  "maintenance:execute",
]);

@Injectable()
export class PendingActionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
  ) {}

  /**
   * Check if an action requires two-person review.
   * If the twoPersonPayoutReview setting is enabled, payout releases are also included.
   */
  async requiresTwoPersonReview(action: string): Promise<boolean> {
    if (TWO_PERSON_REVIEW_ACTIONS.has(action)) return true;

    if (action === "payout:release") {
      const setting = await this.prisma.adminSetting.findUnique({
        where: { key: "twoPersonPayoutReview" },
      });
      return setting?.enabled ?? true;
    }

    return false;
  }

  async createPendingAction(
    adminUserId: string,
    input: {
      action: string;
      targetType: string;
      targetId: string;
      payload: Record<string, unknown>;
      summary: string;
    },
    ctx?: AdminRequestContext,
  ) {
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + PENDING_ACTION_EXPIRY_HOURS);

    const pending = await this.prisma.pendingAdminAction.create({
      data: {
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        payload: input.payload as any,
        requestedBy: adminUserId,
        status: "PENDING",
        expiresAt,
      },
    });

    await this.audit.log(adminUserId, {
      detail: `Requested two-person review for: ${input.summary}`,
      icon: "pending_actions",
      summary: `Pending review: ${input.summary}`,
      targetId: pending.id,
      targetType: "PENDING_ACTION",
    }, ctx);

    return {
      pendingActionId: pending.id,
      message: `Action requires approval from another admin. Expires in ${PENDING_ACTION_EXPIRY_HOURS} hours.`,
      expiresAt: pending.expiresAt,
    };
  }

  async listPendingActions() {
    const actions = await this.prisma.pendingAdminAction.findMany({
      where: {
        status: "PENDING",
        expiresAt: { gt: new Date() },
      },
      include: {
        requestedByUser: { include: { profile: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    return {
      pendingActions: actions.map((a) => ({
        id: a.id,
        action: a.action,
        targetType: a.targetType,
        targetId: a.targetId,
        payload: a.payload,
        requestedBy: {
          id: a.requestedByUser.id,
          displayName: getDisplayName(a.requestedByUser),
        },
        createdAt: a.createdAt,
        expiresAt: a.expiresAt,
      })),
    };
  }

  async approveAction(
    reviewerUserId: string,
    pendingActionId: string,
    note?: string | null,
    ctx?: AdminRequestContext,
  ) {
    const action = await this.prisma.pendingAdminAction.findUnique({
      where: { id: pendingActionId },
      include: { requestedByUser: { include: { profile: true } } },
    });

    if (!action) throw new NotFoundException("Pending action not found.");
    if (action.status !== "PENDING") throw new BadRequestException("Action is no longer pending.");
    if (action.expiresAt < new Date()) throw new BadRequestException("Action has expired.");
    if (action.requestedBy === reviewerUserId) {
      throw new ForbiddenException("You cannot approve your own action. A different admin must review.");
    }

    await this.prisma.pendingAdminAction.update({
      where: { id: pendingActionId },
      data: {
        status: "APPROVED",
        reviewedBy: reviewerUserId,
        reviewNote: note ?? null,
        reviewedAt: new Date(),
      },
    });

    await this.audit.log(reviewerUserId, {
      detail: `Approved pending action "${action.action}" on ${action.targetType}:${action.targetId}, requested by ${getDisplayName(action.requestedByUser)}.`,
      icon: "check_circle",
      summary: `Approved: ${action.action}`,
      targetId: pendingActionId,
      targetType: "PENDING_ACTION",
      tone: "success",
    }, ctx);

    return {
      approved: true,
      action: action.action,
      targetType: action.targetType,
      targetId: action.targetId,
      payload: action.payload,
      message: "Action approved. It will now be executed.",
    };
  }

  async rejectAction(
    reviewerUserId: string,
    pendingActionId: string,
    note?: string | null,
    ctx?: AdminRequestContext,
  ) {
    const action = await this.prisma.pendingAdminAction.findUnique({
      where: { id: pendingActionId },
      include: { requestedByUser: { include: { profile: true } } },
    });

    if (!action) throw new NotFoundException("Pending action not found.");
    if (action.status !== "PENDING") throw new BadRequestException("Action is no longer pending.");

    await this.prisma.pendingAdminAction.update({
      where: { id: pendingActionId },
      data: {
        status: "REJECTED",
        reviewedBy: reviewerUserId,
        reviewNote: note ?? null,
        reviewedAt: new Date(),
      },
    });

    await this.audit.log(reviewerUserId, {
      detail: `Rejected pending action "${action.action}" on ${action.targetType}:${action.targetId}, requested by ${getDisplayName(action.requestedByUser)}.`,
      icon: "cancel",
      summary: `Rejected: ${action.action}`,
      targetId: pendingActionId,
      targetType: "PENDING_ACTION",
      tone: "warning",
    }, ctx);

    return {
      rejected: true,
      message: "Action rejected.",
    };
  }
}
