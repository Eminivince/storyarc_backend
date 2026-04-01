import { Injectable } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";

export type AdminAuditInput = {
  detail: string;
  icon?: string;
  summary: string;
  targetId?: string | null;
  targetType: string;
  tone?: string;
};

export type AdminRequestContext = {
  ipAddress?: string;
  userAgent?: string;
};

@Injectable()
export class AdminAuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(
    adminUserId: string | null,
    input: AdminAuditInput,
    context?: AdminRequestContext,
  ) {
    await this.prisma.adminAuditLog.create({
      data: {
        action: input.summary,
        adminUserId,
        detail: input.detail,
        icon: input.icon ?? "bolt",
        ipAddress: context?.ipAddress ?? null,
        summary: input.summary,
        targetId: input.targetId ?? null,
        targetType: input.targetType,
        tone: input.tone ?? "primary",
        userAgent: context?.userAgent ?? null,
      },
    });
  }
}
