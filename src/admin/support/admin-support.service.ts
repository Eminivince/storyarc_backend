import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../../database/prisma.service";
import { AdminAuditService, AdminRequestContext } from "../admin-audit.service";
import {
  formatActivityGroupLabel,
  formatCompactNumber,
  formatCurrency,
  formatRelativeDate,
  formatTime,
  getAvatarUrl,
  getDisplayName,
  formatRelativeDateShort,
} from "../admin-format.utils";

@Injectable()
export class AdminSupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
  ) {}

  private async requireAdmin(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { profile: true },
    });
    if (!user || user.status !== "ACTIVE")
      throw new NotFoundException("User not found.");
    if (user.role !== "ADMIN")
      throw new ForbiddenException("Admin access is required.");
    return user;
  }

  // ── Activity ─────────────────────────────────────────────────────

  async getAdminActivity(adminUserId: string, ctx?: AdminRequestContext) {
    await this.requireAdmin(adminUserId);

    const logs = await this.prisma.adminAuditLog.findMany({
      include: {
        adminUser: {
          include: {
            profile: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    const grouped = logs.reduce(
      (groups, item) => {
        const label = formatActivityGroupLabel(item.createdAt);
        const currentGroup = groups.get(label) ?? [];

        currentGroup.push({
          admin: item.adminUser ? getDisplayName(item.adminUser) : "System",
          detail: item.detail,
          icon: item.icon,
          id: item.id,
          summary: item.summary,
          time: formatRelativeDate(item.createdAt),
          tone: item.tone,
        });
        groups.set(label, currentGroup);
        return groups;
      },
      new Map<string, Array<Record<string, string>>>(),
    );

    return {
      activityGroups: Array.from(grouped.entries()).map(([label, items]) => ({
        items,
        label,
      })),
    };
  }

  // ── Messages ─────────────────────────────────────────────────────

  async getAdminMessages(adminUserId: string, ctx?: AdminRequestContext) {
    await this.requireAdmin(adminUserId);

    const tickets = await this.prisma.supportTicket.findMany({
      include: {
        messages: {
          orderBy: { createdAt: "asc" },
        },
        requester: {
          include: {
            profile: true,
          },
        },
      },
      orderBy: { updatedAt: "desc" },
    });

    return {
      conversations: await Promise.all(
        tickets.map((ticket) => this.mapConversation(ticket)),
      ),
    };
  }

  // ── Reply ────────────────────────────────────────────────────────

  async replyToSupportTicket(
    adminUserId: string,
    ticketId: string,
    body: string,
    ctx?: AdminRequestContext,
  ) {
    const admin = await this.requireAdmin(adminUserId);
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id: ticketId },
      include: {
        requester: {
          include: {
            profile: true,
          },
        },
      },
    });

    if (!ticket) {
      throw new NotFoundException("Support ticket not found.");
    }

    await this.prisma.supportMessage.create({
      data: {
        body,
        senderRole: "ADMIN",
        senderUserId: admin.id,
        ticketId,
      },
    });

    await this.prisma.supportTicket.update({
      where: { id: ticketId },
      data: {
        assignedAdminId: admin.id,
        latestPreview: body,
        status: "PENDING",
      },
    });

    await this.audit.log(
      admin.id,
      {
        detail: `Creator or reader messaging thread updated for ${getDisplayName(ticket.requester)}.`,
        icon: "chat",
        summary: "Replied to support conversation",
        targetId: ticketId,
        targetType: "SUPPORT_TICKET",
      },
      ctx,
    );

    return {
      message: "Reply sent to the conversation.",
    };
  }

  // ── Private helpers ──────────────────────────────────────────────

  private async mapConversation(ticket: any) {
    const requester = ticket.requester;
    const storiesCount = await this.prisma.story.count({
      where: { authorId: requester.id },
    });
    const purchases = await this.prisma.purchase.aggregate({
      _sum: { amountCents: true },
      where: { userId: requester.id },
    });

    return {
      accountOverview: {
        status:
          requester.role === "CREATOR"
            ? "Creator Account"
            : requester.role === "ADMIN"
              ? "Admin"
              : "Reader",
        stories: formatCompactNumber(storiesCount),
        totalSpend: formatCurrency(purchases._sum.amountCents ?? 0),
      },
      avatar: getAvatarUrl(requester),
      id: ticket.id,
      messages: ticket.messages.map((message: any) => ({
        id: message.id,
        sender: message.senderRole === "ADMIN" ? "admin" : "user",
        text: message.body,
        time: formatTime(message.createdAt),
      })),
      preview: ticket.latestPreview ?? ticket.subject,
      profileHref: `/admin/users/${requester.id}`,
      roleLabel:
        requester.role === "CREATOR" ? "TaleStead Creator" : "Reader",
      status:
        ticket.status === "OPEN"
          ? "online"
          : ticket.status === "PENDING"
            ? "away"
            : "offline",
      updatedAt: formatRelativeDateShort(ticket.updatedAt),
      userName: getDisplayName(requester),
    };
  }
}
