import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { AdminSettingKind } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { RedisService } from "../../redis/redis.service";
import { AdminAuditService } from "../admin-audit.service";
import { defaultAdminSettings, maintenanceActionLabels, type AdminSettingValueInput } from "../admin-constants";
import { formatCurrency, formatPercentage } from "../admin-format.utils";

@Injectable()
export class AdminSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
    private readonly redis: RedisService,
  ) {}

  private async getAdminUser(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("User not found.");
    return user;
  }

  async ensureAdminDefaults() {
    for (const setting of defaultAdminSettings) {
      await this.prisma.adminSetting.upsert({
        where: { key: setting.key },
        update: {},
        create: {
          key: setting.key,
          kind: setting.kind,
          group: setting.group,
          title: setting.title,
          description: setting.description,
          enabled: setting.enabled,
          valueCents: setting.valueCents,
        },
      });
    }
  }

  async getAdminSettings(adminUserId: string) {
    await this.ensureAdminDefaults();

    const settings = await this.prisma.adminSetting.findMany({
      orderBy: [{ group: "asc" }, { title: "asc" }],
    });

    return {
      settings: settings.map((setting) => {
        const baseSetting = {
          description: setting.description,
          enabled: setting.enabled,
          group: setting.group,
          id: setting.key,
          kind: setting.kind,
          title: setting.title,
        };

        if (
          setting.kind !== AdminSettingKind.CURRENCY_CENTS &&
          setting.kind !== AdminSettingKind.PERCENTAGE
        ) {
          return baseSetting;
        }

        const fallbackValueCents =
          defaultAdminSettings.find((item) => item.key === setting.key)?.valueCents ?? 0;
        const valueCents = setting.valueCents ?? fallbackValueCents;

        return {
          ...baseSetting,
          formattedValue:
            setting.kind === AdminSettingKind.PERCENTAGE
              ? formatPercentage(valueCents)
              : formatCurrency(valueCents),
          valueCents,
        };
      }),
    };
  }

  async toggleAdminSetting(adminUserId: string, settingKey: string) {
    const admin = await this.getAdminUser(adminUserId);
    await this.ensureAdminDefaults();

    const setting = await this.prisma.adminSetting.findUnique({ where: { key: settingKey } });
    if (!setting) throw new NotFoundException("Setting not found.");
    if (setting.kind !== AdminSettingKind.BOOLEAN) throw new BadRequestException("This setting cannot be toggled.");

    const updated = await this.prisma.adminSetting.update({
      where: { key: settingKey },
      data: { enabled: !setting.enabled },
    });

    await this.audit.log(admin.id, {
      detail: `${updated.title} ${updated.enabled ? "enabled" : "disabled"} from system settings.`,
      icon: "tune",
      summary: `${updated.title} ${updated.enabled ? "enabled" : "disabled"}`,
      targetId: updated.id,
      targetType: "SETTING",
    });

    return { message: `${updated.title} ${updated.enabled ? "enabled" : "disabled"}.` };
  }

  async updateAdminSettingValue(adminUserId: string, settingKey: string, input: AdminSettingValueInput) {
    const admin = await this.getAdminUser(adminUserId);
    await this.ensureAdminDefaults();

    const setting = await this.prisma.adminSetting.findUnique({ where: { key: settingKey } });
    if (!setting) throw new NotFoundException("Setting not found.");

    if (setting.kind !== AdminSettingKind.CURRENCY_CENTS && setting.kind !== AdminSettingKind.PERCENTAGE) {
      throw new BadRequestException("This setting does not support a numeric value.");
    }

    if (setting.kind === AdminSettingKind.PERCENTAGE && (input.valueCents < 0 || input.valueCents > 100)) {
      throw new BadRequestException("Percentage settings must be between 0 and 100.");
    }

    const updated = await this.prisma.adminSetting.update({
      where: { key: settingKey },
      data: { valueCents: input.valueCents },
    });

    const formattedValue =
      updated.kind === AdminSettingKind.PERCENTAGE
        ? formatPercentage(updated.valueCents ?? 0)
        : formatCurrency(updated.valueCents ?? 0);

    await this.audit.log(admin.id, {
      detail: `${updated.title} updated to ${formattedValue} from system settings.`,
      icon: "tune",
      summary: `Updated ${updated.title}`,
      targetId: updated.id,
      targetType: "SETTING",
    });

    return { message: `${updated.title} updated to ${formattedValue}.` };
  }

  async runMaintenanceAction(adminUserId: string, actionId: string) {
    const admin = await this.getAdminUser(adminUserId);
    const label = maintenanceActionLabels[actionId];

    if (!label) throw new BadRequestException("Unknown maintenance action.");

    if (actionId === "purge-sessions") {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      await this.prisma.session.deleteMany({
        where: {
          OR: [
            { revokedAt: { not: null, lt: thirtyDaysAgo } },
            { refreshTokenExpiresAt: { lt: new Date() } },
          ],
        },
      });
    }

    await this.audit.log(admin.id, {
      detail: "Maintenance was triggered from the admin console.",
      icon: "build",
      summary: label,
      targetId: actionId,
      targetType: "MAINTENANCE",
      tone: "amber",
    });

    return { message: `${label}.` };
  }
}
