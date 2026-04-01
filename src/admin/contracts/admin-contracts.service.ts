import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ContractExclusivity } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { AdminAuditService, AdminRequestContext } from "../admin-audit.service";
import {
  AdminContractInput,
  AdminContractTemplateInput,
  adminContractInclude,
  contractTemplateCountInclude,
  ContractStatus,
} from "../admin-constants";
import {
  buildInitials,
  formatDate,
  formatRelativeDate,
  formatTermMonths,
  getDisplayName,
  mapContractExclusivityLabel,
  mapContractStatusLabel,
} from "../admin-format.utils";
import {
  creatorExclusiveRevenueShareSettingKey,
  creatorNonExclusiveRevenueShareSettingKey,
  getDefaultCreatorRevenueSharePercent,
} from "../../creator/creator-finance.constants";

@Injectable()
export class AdminContractsService {
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

  // ── Lookups ──────────────────────────────────────────────────────

  async getAdminContractLookups(
    adminUserId: string,
    ctx?: AdminRequestContext,
  ) {

    const contractRevenueDefaults =
      await this.getCreatorRevenueShareDefaults();

    const [users, stories, templates] = await Promise.all([
      this.prisma.user.findMany({
        where: { status: { not: "DELETED" } },
        select: {
          email: true,
          id: true,
          profile: { select: { displayName: true } },
          status: true,
        },
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.story.findMany({
        select: {
          author: { select: { profile: { select: { displayName: true } } } },
          authorName: true,
          id: true,
          slug: true,
          status: true,
          title: true,
        },
        orderBy: { updatedAt: "desc" },
      }),
      this.prisma.contractTemplate.findMany({
        orderBy: { updatedAt: "desc" },
        select: {
          companyName: true,
          exclusivity: true,
          id: true,
          revenueSharePercent: true,
          templateName: true,
          termMonths: true,
        },
      }),
    ]);

    return {
      stories: stories.map((story) => ({
        authorName: story.author?.profile?.displayName ?? story.authorName,
        id: story.id,
        slug: story.slug,
        status: story.status,
        title: story.title,
      })),
      templates: templates.map((template) => ({
        companyName: template.companyName,
        exclusivity: template.exclusivity,
        id: template.id,
        revenueSharePercent: template.revenueSharePercent,
        templateName: template.templateName,
        termMonths: template.termMonths,
      })),
      users: users.map((user) => ({
        displayName: user.profile?.displayName ?? user.email!.split("@")[0],
        email: user.email!,
        id: user.id,
        status: user.status,
      })),
      revenueShareDefaults: contractRevenueDefaults,
    };
  }

  // ── Templates ────────────────────────────────────────────────────

  async listAdminContractTemplates(
    adminUserId: string,
    ctx?: AdminRequestContext,
  ) {

    const templates = await this.prisma.contractTemplate.findMany({
      include: contractTemplateCountInclude,
      orderBy: { updatedAt: "desc" },
    });

    return {
      templates: templates.map((template) =>
        this.mapAdminContractTemplateSummary(template),
      ),
    };
  }

  async getAdminContractTemplate(
    adminUserId: string,
    templateId: string,
    ctx?: AdminRequestContext,
  ) {
    const template = await this.getContractTemplateOrThrow(templateId);

    return {
      template: this.mapAdminContractTemplateDetail(template),
    };
  }

  async createAdminContractTemplate(
    adminUserId: string,
    input: AdminContractTemplateInput,
    ctx?: AdminRequestContext,
  ) {
    const admin = await this.getAdminUser(adminUserId);
    const template = await this.prisma.contractTemplate.create({
      data: {
        advancePaymentCents: input.advancePaymentCents,
        body: input.body,
        companyName: input.companyName,
        createdByAdminUserId: admin.id,
        description: input.description,
        exclusivity: input.exclusivity,
        geographicRights: input.geographicRights,
        revenueSharePercent: input.revenueSharePercent,
        signingBonusCoins: input.signingBonusCoins,
        templateName: input.templateName,
        termMonths: input.termMonths,
        updatedByAdminUserId: admin.id,
      },
      include: contractTemplateCountInclude,
    });

    await this.audit.log(
      admin.id,
      {
        detail: `Created contract template ${template.templateName}.`,
        icon: "description",
        summary: `Created template ${template.templateName}`,
        targetId: template.id,
        targetType: "CONTRACT_TEMPLATE",
      },
      ctx,
    );

    return {
      message: `Template "${template.templateName}" saved.`,
      template: this.mapAdminContractTemplateDetail(template),
    };
  }

  async updateAdminContractTemplate(
    adminUserId: string,
    templateId: string,
    input: AdminContractTemplateInput,
    ctx?: AdminRequestContext,
  ) {
    const admin = await this.getAdminUser(adminUserId);
    await this.getContractTemplateOrThrow(templateId);

    const template = await this.prisma.contractTemplate.update({
      where: { id: templateId },
      data: {
        advancePaymentCents: input.advancePaymentCents,
        body: input.body,
        companyName: input.companyName,
        description: input.description,
        exclusivity: input.exclusivity,
        geographicRights: input.geographicRights,
        revenueSharePercent: input.revenueSharePercent,
        signingBonusCoins: input.signingBonusCoins,
        templateName: input.templateName,
        termMonths: input.termMonths,
        updatedByAdminUserId: admin.id,
      },
      include: contractTemplateCountInclude,
    });

    await this.audit.log(
      admin.id,
      {
        detail: `Updated contract template ${template.templateName}.`,
        icon: "edit_document",
        summary: `Updated template ${template.templateName}`,
        targetId: template.id,
        targetType: "CONTRACT_TEMPLATE",
      },
      ctx,
    );

    return {
      message: `Template "${template.templateName}" updated.`,
      template: this.mapAdminContractTemplateDetail(template),
    };
  }

  // ── Contracts ────────────────────────────────────────────────────

  async listAdminContracts(
    adminUserId: string,
    ctx?: AdminRequestContext,
  ) {

    const contracts = await this.prisma.contract.findMany({
      include: adminContractInclude,
      orderBy: { updatedAt: "desc" },
    });

    return {
      contracts: contracts.map((contract) =>
        this.mapAdminContractSummary(contract),
      ),
    };
  }

  async getAdminContract(
    adminUserId: string,
    contractId: string,
    ctx?: AdminRequestContext,
  ) {
    const contract = await this.getContractOrThrow(contractId);

    return {
      contract: this.mapAdminContractDetail(contract),
    };
  }

  async createAdminContract(
    adminUserId: string,
    input: AdminContractInput,
    ctx?: AdminRequestContext,
  ) {
    const admin = await this.getAdminUser(adminUserId);
    await this.assertContractPartyEligibleForRevenueShare(
      input.userId,
      input.revenueSharePercent,
    );
    const [party, story, template] = await Promise.all([
      this.getContractPartyUserOrThrow(input.userId),
      this.getContractStoryOrThrow(input.storyId),
      input.templateId
        ? this.getContractTemplateOrThrow(input.templateId)
        : null,
    ]);
    const sequence = await this.nextAdminSequenceValue("contract");
    const displayId = this.formatContractDisplayId(sequence);
    const lifecycleFields = this.getContractLifecycleUpdate(null, input.status);

    const contract = await this.prisma.contract.create({
      data: {
        advancePaymentCents: input.advancePaymentCents,
        activatedAt: lifecycleFields.activatedAt,
        body: input.body,
        companyName: input.companyName,
        contractType: input.contractType,
        createdByAdminUserId: admin.id,
        displayId,
        endedAt: lifecycleFields.endedAt,
        geographicRights: input.geographicRights,
        partyRole: input.partyRole,
        revenueSharePercent: input.revenueSharePercent,
        signingBonusCoins: input.signingBonusCoins,
        status: input.status,
        storyId: input.storyId,
        templateId: template?.id ?? null,
        templateName: input.templateName,
        termMonths: input.termMonths,
        updatedByAdminUserId: admin.id,
        userId: input.userId,
      },
      include: adminContractInclude,
    });

    await this.audit.log(
      admin.id,
      {
        detail: `Created ${displayId} for ${getDisplayName(party)} on ${story.title}.`,
        icon: "description",
        summary: `Created contract ${displayId}`,
        targetId: contract.id,
        targetType: "CONTRACT",
      },
      ctx,
    );

    return {
      contract: this.mapAdminContractDetail(contract),
      message: `${displayId} created.`,
    };
  }

  async updateAdminContract(
    adminUserId: string,
    contractId: string,
    input: AdminContractInput,
    ctx?: AdminRequestContext,
  ) {
    const admin = await this.getAdminUser(adminUserId);
    const existingContract = await this.getContractOrThrow(contractId);
    await this.assertContractPartyEligibleForRevenueShare(
      input.userId,
      input.revenueSharePercent,
    );
    const [party, story, template] = await Promise.all([
      this.getContractPartyUserOrThrow(input.userId),
      this.getContractStoryOrThrow(input.storyId),
      input.templateId
        ? this.getContractTemplateOrThrow(input.templateId)
        : null,
    ]);
    const lifecycleFields = this.getContractLifecycleUpdate(
      {
        activatedAt: existingContract.activatedAt,
        endedAt: existingContract.endedAt,
        status: existingContract.status,
      },
      input.status,
    );

    const contract = await this.prisma.contract.update({
      where: { id: contractId },
      data: {
        advancePaymentCents: input.advancePaymentCents,
        activatedAt: lifecycleFields.activatedAt,
        body: input.body,
        companyName: input.companyName,
        contractType: input.contractType,
        endedAt: lifecycleFields.endedAt,
        geographicRights: input.geographicRights,
        partyRole: input.partyRole,
        revenueSharePercent: input.revenueSharePercent,
        signingBonusCoins: input.signingBonusCoins,
        status: input.status,
        storyId: input.storyId,
        templateId: template?.id ?? null,
        templateName: input.templateName,
        termMonths: input.termMonths,
        updatedByAdminUserId: admin.id,
        userId: input.userId,
      },
      include: adminContractInclude,
    });

    await this.audit.log(
      admin.id,
      {
        detail: `Updated ${contract.displayId} for ${getDisplayName(party)} on ${story.title}.`,
        icon: "edit_document",
        summary: `Updated contract ${contract.displayId}`,
        targetId: contract.id,
        targetType: "CONTRACT",
      },
      ctx,
    );

    return {
      contract: this.mapAdminContractDetail(contract),
      message: `${contract.displayId} updated.`,
    };
  }

  // ── Private helpers ──────────────────────────────────────────────

  private async getContractTemplateOrThrow(templateId: string) {
    const template = await this.prisma.contractTemplate.findUnique({
      where: { id: templateId },
      include: contractTemplateCountInclude,
    });

    if (!template) {
      throw new NotFoundException("Contract template not found.");
    }

    return template;
  }

  private async getContractOrThrow(contractId: string) {
    const contract = await this.prisma.contract.findUnique({
      where: { id: contractId },
      include: adminContractInclude,
    });

    if (!contract) {
      throw new NotFoundException("Contract not found.");
    }

    return contract;
  }

  private async getContractPartyUserOrThrow(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { profile: true },
    });

    if (!user || user.status === "DELETED") {
      throw new NotFoundException("Contract user not found.");
    }

    return user;
  }

  /**
   * Writers approved "studio only" cannot hold contracts that pay a revenue share from purchases.
   * Missing application rows (e.g. legacy or seeded creators) are allowed.
   */
  private async assertContractPartyEligibleForRevenueShare(
    userId: string,
    revenueSharePercent: number,
  ) {
    if (revenueSharePercent <= 0) {
      return;
    }

    const application = await this.prisma.creatorApplication.findUnique({
      where: { userId },
    });

    if (!application || application.status !== "APPROVED") {
      return;
    }

    const allowed = application.revenueShareContractApproved ?? true;

    if (!allowed) {
      throw new BadRequestException(
        "This creator was approved without revenue-sharing eligibility. Use studio-only access or update their application before assigning a contract with revenue share.",
      );
    }
  }

  private async getContractStoryOrThrow(storyId: string) {
    const story = await this.prisma.story.findUnique({
      where: { id: storyId },
      include: {
        author: { include: { profile: true } },
      },
    });

    if (!story) {
      throw new NotFoundException("Contract story not found.");
    }

    return story;
  }

  private async nextAdminSequenceValue(key: string) {
    const sequence = await this.prisma.adminSequence.upsert({
      where: { key },
      create: { key, value: 1 },
      update: { value: { increment: 1 } },
    });

    return sequence.value;
  }

  private formatContractDisplayId(value: number) {
    return `CTR-${String(value).padStart(3, "0")}`;
  }

  private async getCreatorRevenueShareDefaults() {
    const settings = await this.prisma.adminSetting.findMany({
      where: {
        key: {
          in: [
            creatorExclusiveRevenueShareSettingKey,
            creatorNonExclusiveRevenueShareSettingKey,
          ],
        },
      },
    });

    const settingsByKey = new Map(
      settings.map((setting) => [setting.key, setting]),
    );

    return {
      exclusive: {
        contractType: ContractExclusivity.EXCLUSIVE,
        revenueSharePercent:
          settingsByKey.get(creatorExclusiveRevenueShareSettingKey)?.valueCents ??
          getDefaultCreatorRevenueSharePercent(ContractExclusivity.EXCLUSIVE),
      },
      nonExclusive: {
        contractType: ContractExclusivity.NON_EXCLUSIVE,
        revenueSharePercent:
          settingsByKey.get(creatorNonExclusiveRevenueShareSettingKey)
            ?.valueCents ??
          getDefaultCreatorRevenueSharePercent(
            ContractExclusivity.NON_EXCLUSIVE,
          ),
      },
    };
  }

  private getContractLifecycleUpdate(
    current:
      | {
          activatedAt: Date | null;
          endedAt: Date | null;
          status: ContractStatus;
        }
      | null,
    nextStatus: ContractStatus,
  ) {
    const now = new Date();

    if (nextStatus === ContractStatus.ACTIVE) {
      return {
        activatedAt: current?.activatedAt ?? now,
        endedAt: null,
      };
    }

    if (
      nextStatus === ContractStatus.EXPIRED ||
      nextStatus === ContractStatus.TERMINATED
    ) {
      return {
        activatedAt: current?.activatedAt ?? now,
        endedAt: current?.endedAt ?? now,
      };
    }

    return {
      activatedAt: null,
      endedAt: null,
    };
  }

  // ── Mappers ──────────────────────────────────────────────────────

  private mapAdminContractTemplateSummary(template: any) {
    return {
      companyName: template.companyName,
      contractCount: template._count?.contracts ?? 0,
      description: template.description ?? "",
      exclusivity: mapContractExclusivityLabel(template.exclusivity),
      exclusivityValue: template.exclusivity,
      id: template.id,
      revenueShare: `${template.revenueSharePercent}%`,
      revenueSharePercent: template.revenueSharePercent,
      templateName: template.templateName,
      termDuration: formatTermMonths(template.termMonths),
      termMonths: template.termMonths,
      updatedAt: formatRelativeDate(template.updatedAt),
    };
  }

  private mapAdminContractTemplateDetail(template: any) {
    return {
      advancePaymentCents: template.advancePaymentCents,
      body: template.body,
      companyName: template.companyName,
      contractCount: template._count?.contracts ?? 0,
      createdAt: template.createdAt.toISOString(),
      description: template.description ?? "",
      exclusivity: template.exclusivity,
      exclusivityLabel: mapContractExclusivityLabel(template.exclusivity),
      geographicRights: template.geographicRights,
      id: template.id,
      revenueSharePercent: template.revenueSharePercent,
      signingBonusCoins: template.signingBonusCoins,
      templateName: template.templateName,
      termDuration: formatTermMonths(template.termMonths),
      termMonths: template.termMonths,
      updatedAt: template.updatedAt.toISOString(),
    };
  }

  private mapAdminContractSummary(contract: any) {
    const userName = getDisplayName(contract.user);

    return {
      contractId: contract.displayId,
      contractType: mapContractExclusivityLabel(contract.contractType),
      contractTypeValue: contract.contractType,
      createdAt: formatDate(contract.createdAt),
      id: contract.id,
      initials: buildInitials(userName),
      partyRole: contract.partyRole,
      status: mapContractStatusLabel(contract.status),
      statusValue: contract.status,
      storyTitle: contract.story.title,
      templateName: contract.templateName,
      updatedAt: formatRelativeDate(contract.updatedAt),
      userName,
    };
  }

  private mapAdminContractDetail(contract: any) {
    const userName = getDisplayName(contract.user);

    return {
      advancePaymentCents: contract.advancePaymentCents,
      body: contract.body,
      companyName: contract.companyName,
      contractId: contract.displayId,
      contractType: contract.contractType,
      contractTypeLabel: mapContractExclusivityLabel(contract.contractType),
      createdAt: contract.createdAt.toISOString(),
      geographicRights: contract.geographicRights,
      id: contract.id,
      partyRole: contract.partyRole,
      revenueSharePercent: contract.revenueSharePercent,
      signingBonusCoins: contract.signingBonusCoins,
      status: contract.status,
      statusLabel: mapContractStatusLabel(contract.status),
      story: {
        authorName:
          contract.story.author?.profile?.displayName ??
          contract.story.authorName,
        id: contract.story.id,
        slug: contract.story.slug,
        title: contract.story.title,
      },
      template: contract.template
        ? {
            id: contract.template.id,
            templateName: contract.template.templateName,
          }
        : null,
      templateId: contract.templateId ?? null,
      templateName: contract.templateName,
      termDuration: formatTermMonths(contract.termMonths),
      termMonths: contract.termMonths,
      updatedAt: contract.updatedAt.toISOString(),
      user: {
        displayName: userName,
        email: contract.user.email,
        id: contract.user.id,
        initials: buildInitials(userName),
        status: contract.user.status,
      },
    };
  }
}
