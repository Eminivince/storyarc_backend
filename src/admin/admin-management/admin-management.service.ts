import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../database/prisma.service";
import { RedisService } from "../../redis/redis.service";
import { AdminAuditService, type AdminRequestContext } from "../admin-audit.service";
import { getDisplayName, getAvatarUrl, mapRoleLabel } from "../admin-format.utils";

const ROLE_CACHE_PREFIX = "admin:role:";

@Injectable()
export class AdminManagementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
    private readonly redis: RedisService,
  ) {}

  async listAdminRoles() {
    const roles = await this.prisma.adminRole.findMany({
      orderBy: { name: "asc" },
      include: { _count: { select: { users: true } } },
    });

    return {
      roles: roles.map((role) => ({
        id: role.id,
        name: role.name,
        label: role.label,
        permissions: role.permissions,
        isSystem: role.isSystem,
        userCount: role._count.users,
      })),
    };
  }

  async listAdminUsers() {
    const users = await this.prisma.user.findMany({
      where: {
        OR: [
          { role: "ADMIN" },
          { role: "MODERATOR" },
          { adminRoleId: { not: null } },
        ],
      },
      include: {
        profile: true,
        adminRole: { select: { id: true, name: true, label: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    return {
      admins: users.map((user) => ({
        id: user.id,
        email: user.email,
        displayName: getDisplayName(user),
        avatarUrl: getAvatarUrl(user),
        role: user.role,
        roleLabel: mapRoleLabel(user.role),
        adminRole: user.adminRole
          ? { id: user.adminRole.id, name: user.adminRole.name, label: user.adminRole.label }
          : null,
        status: user.status,
        createdAt: user.createdAt,
      })),
    };
  }

  async assignAdminRole(
    adminUserId: string,
    targetUserId: string,
    adminRoleId: string,
    ctx?: AdminRequestContext,
  ) {
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      include: { profile: true, adminRole: true },
    });

    if (!target) throw new NotFoundException("User not found.");

    const role = await this.prisma.adminRole.findUnique({
      where: { id: adminRoleId },
    });

    if (!role) throw new NotFoundException("Admin role not found.");

    // Only SUPER_ADMIN can assign SUPER_ADMIN role
    const admin = await this.prisma.user.findUnique({
      where: { id: adminUserId },
      include: { adminRole: true },
    });

    if (role.name === "SUPER_ADMIN" && admin?.adminRole?.name !== "SUPER_ADMIN") {
      throw new ForbiddenException("Only a Super Admin can assign the Super Admin role.");
    }

    // Update user: set adminRoleId and ensure role is ADMIN or MODERATOR
    const newUserRole = role.name === "MODERATOR" ? "MODERATOR" : "ADMIN";

    await this.prisma.user.update({
      where: { id: targetUserId },
      data: {
        adminRoleId: adminRoleId,
        role: newUserRole as any,
      },
    });

    // Invalidate permission cache
    await this.redis.delete(`${ROLE_CACHE_PREFIX}${targetUserId}`);

    await this.audit.log(adminUserId, {
      detail: `Assigned role "${role.label}" to ${getDisplayName(target)}.`,
      icon: "admin_panel_settings",
      summary: `Assigned admin role "${role.label}"`,
      targetId: targetUserId,
      targetType: "USER",
    }, ctx);

    return {
      message: `Assigned "${role.label}" role to ${getDisplayName(target)}.`,
    };
  }

  async revokeAdminRole(
    adminUserId: string,
    targetUserId: string,
    ctx?: AdminRequestContext,
  ) {
    if (adminUserId === targetUserId) {
      throw new BadRequestException("You cannot revoke your own admin role.");
    }

    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      include: { profile: true, adminRole: true },
    });

    if (!target) throw new NotFoundException("User not found.");
    if (!target.adminRoleId) throw new BadRequestException("User has no admin role assigned.");

    // Only SUPER_ADMIN can revoke SUPER_ADMIN
    if (target.adminRole?.name === "SUPER_ADMIN") {
      const admin = await this.prisma.user.findUnique({
        where: { id: adminUserId },
        include: { adminRole: true },
      });
      if (admin?.adminRole?.name !== "SUPER_ADMIN") {
        throw new ForbiddenException("Only a Super Admin can revoke the Super Admin role.");
      }
    }

    const previousRole = target.adminRole?.label ?? "Unknown";

    await this.prisma.user.update({
      where: { id: targetUserId },
      data: {
        adminRoleId: null,
        role: "READER",
      },
    });

    // Invalidate permission cache
    await this.redis.delete(`${ROLE_CACHE_PREFIX}${targetUserId}`);

    await this.audit.log(adminUserId, {
      detail: `Revoked admin role "${previousRole}" from ${getDisplayName(target)}. User demoted to READER.`,
      icon: "person_remove",
      summary: `Revoked admin role from ${getDisplayName(target)}`,
      targetId: targetUserId,
      targetType: "USER",
      tone: "warning",
    }, ctx);

    return {
      message: `Revoked admin access from ${getDisplayName(target)}.`,
    };
  }
}
