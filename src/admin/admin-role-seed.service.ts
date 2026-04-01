import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { DEFAULT_ADMIN_ROLES } from "./admin-role-seeds";

/**
 * Seeds default AdminRole records on startup.
 * Existing roles are updated (permissions synced), new ones are created.
 * System roles cannot be deleted.
 */
@Injectable()
export class AdminRoleSeedService implements OnModuleInit {
  private readonly logger = new Logger(AdminRoleSeedService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.seedDefaultRoles();
  }

  async seedDefaultRoles() {
    for (const role of DEFAULT_ADMIN_ROLES) {
      await this.prisma.adminRole.upsert({
        where: { name: role.name },
        update: {
          label: role.label,
          permissions: role.permissions,
          isSystem: role.isSystem,
        },
        create: {
          name: role.name,
          label: role.label,
          permissions: role.permissions,
          isSystem: role.isSystem,
        },
      });
    }

    this.logger.log(`Seeded ${DEFAULT_ADMIN_ROLES.length} default admin roles`);
  }
}
