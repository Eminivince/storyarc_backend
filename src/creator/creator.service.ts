import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { ContractExclusivity } from "@prisma/client";
import { ResendEmailService } from "../auth/resend-email.service";
import { env } from "../config/env";
import { PrismaService } from "../database/prisma.service";
import {
  creatorExclusiveRevenueShareSettingKey,
  creatorNonExclusiveRevenueShareSettingKey,
  getDefaultCreatorRevenueSharePercent,
} from "./creator-finance.constants";
import {
  CreatorApplicationInput,
  CreatorApplicationStatus,
  ReviewCreatorApplicationInput,
} from "./creator.types";

@Injectable()
export class CreatorService {
  private readonly logger = new Logger(CreatorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly resendEmailService: ResendEmailService,
  ) {}

  async getCurrentUserApplication(userId: string) {
    await this.getActiveUser(userId);

    const [application, contractTerms] = await Promise.all([
      this.prisma.creatorApplication.findUnique({
        where: {
          userId,
        },
        include: {
          reviewedByUser: {
            include: {
              profile: true,
            },
          },
        },
      }),
      this.getCreatorContractTerms(),
    ]);

    return {
      application: application ? this.mapApplication(application) : null,
      contractTerms,
    };
  }

  async saveDraft(userId: string, input: CreatorApplicationInput) {
    const user = await this.getActiveUser(userId, {
      includeProfile: true,
    });

    if (user.role !== "READER") {
      throw new ConflictException("Creator access is already active for this account.");
    }

    const existingApplication = await this.prisma.creatorApplication.findUnique({
      where: {
        userId,
      },
    });

    if (existingApplication?.status === "SUBMITTED") {
      throw new ConflictException(
        "This application is already under review and cannot be edited right now.",
      );
    }

    const application = await this.prisma.creatorApplication.upsert({
      where: {
        userId,
      },
      create: {
        userId,
        fullName: input.fullName || user.profile?.displayName || "TaleStead Creator",
        email: input.email || user.email!,
        primaryGenre: input.primaryGenre,
        experience: input.experience,
        portfolioUrl: input.portfolioUrl,
        motivation: input.motivation,
        wantsContract: input.wantsContract,
        requestedContractType: input.wantsContract
          ? input.requestedContractType
          : null,
        reviewedAt: null,
        reviewedByUserId: null,
        reviewNotes: null,
        status: "DRAFT",
        submittedAt: null,
      },
      update: {
        fullName: input.fullName || user.profile?.displayName || "TaleStead Creator",
        email: input.email || user.email!,
        primaryGenre: input.primaryGenre,
        experience: input.experience,
        portfolioUrl: input.portfolioUrl,
        motivation: input.motivation,
        wantsContract: input.wantsContract,
        requestedContractType: input.wantsContract
          ? input.requestedContractType
          : null,
        reviewedAt: null,
        reviewedByUserId: null,
        reviewNotes: null,
        status: "DRAFT",
        submittedAt: null,
      },
      include: {
        reviewedByUser: {
          include: {
            profile: true,
          },
        },
      },
    });

    return {
      application: this.mapApplication(application),
      contractTerms: await this.getCreatorContractTerms(),
      message: "Creator application draft saved.",
    };
  }

  async submitApplication(userId: string, input: CreatorApplicationInput) {
    const user = await this.getActiveUser(userId, {
      includeProfile: true,
    });

    if (user.role !== "READER") {
      throw new ConflictException("Creator access is already active for this account.");
    }

    const existingApplication = await this.prisma.creatorApplication.findUnique({
      where: {
        userId,
      },
      include: {
        reviewedByUser: {
          include: {
            profile: true,
          },
        },
      },
    });

    if (existingApplication?.status === "SUBMITTED") {
      return {
        application: this.mapApplication(existingApplication),
        contractTerms: await this.getCreatorContractTerms(),
        message: "Creator application is already under review.",
      };
    }

    const submittedAt = new Date();
    const application = await this.prisma.creatorApplication.upsert({
      where: {
        userId,
      },
      create: {
        userId,
        fullName: input.fullName || user.profile?.displayName || "TaleStead Creator",
        email: input.email || user.email!,
        primaryGenre: input.primaryGenre,
        experience: input.experience,
        portfolioUrl: input.portfolioUrl,
        motivation: input.motivation,
        wantsContract: input.wantsContract,
        requestedContractType: input.wantsContract
          ? input.requestedContractType
          : null,
        reviewedAt: null,
        reviewedByUserId: null,
        reviewNotes: null,
        status: "SUBMITTED",
        submittedAt,
      },
      update: {
        fullName: input.fullName || user.profile?.displayName || "TaleStead Creator",
        email: input.email || user.email!,
        primaryGenre: input.primaryGenre,
        experience: input.experience,
        portfolioUrl: input.portfolioUrl,
        motivation: input.motivation,
        wantsContract: input.wantsContract,
        requestedContractType: input.wantsContract
          ? input.requestedContractType
          : null,
        reviewedAt: null,
        reviewedByUserId: null,
        reviewNotes: null,
        status: "SUBMITTED",
        submittedAt,
      },
      include: {
        reviewedByUser: {
          include: {
            profile: true,
          },
        },
      },
    });

    return {
      application: this.mapApplication(application),
      contractTerms: await this.getCreatorContractTerms(),
      message: "Creator application submitted for review.",
    };
  }

  async listApplications(status?: CreatorApplicationStatus) {
    const applications = await this.prisma.creatorApplication.findMany({
      where: status
        ? {
            status,
          }
        : undefined,
      orderBy: [{ submittedAt: "desc" }, { updatedAt: "desc" }],
      include: {
        reviewedByUser: {
          include: {
            profile: true,
          },
        },
      },
    });
    const userIds = Array.from(new Set(applications.map((application) => application.userId)));
    const users = userIds.length
      ? await this.prisma.user.findMany({
          where: {
            id: {
              in: userIds,
            },
          },
          include: {
            profile: true,
          },
        })
      : [];
    const usersById = new Map(users.map((user) => [user.id, user]));

    return {
      applications: applications
        .filter((application) => usersById.has(application.userId))
        .map((application) =>
          this.mapApplication(
            {
              ...application,
              user: usersById.get(application.userId),
            },
            {
              includeApplicant: true,
            },
          ),
        ),
    };
  }

  async approveApplication(
    applicationId: string,
    reviewerUserId: string,
    input: ReviewCreatorApplicationInput,
  ) {
    const application = await this.prisma.creatorApplication.findUnique({
      where: {
        id: applicationId,
      },
      include: {
        reviewedByUser: {
          include: {
            profile: true,
          },
        },
      },
    });

    if (!application) {
      throw new NotFoundException("Creator application not found.");
    }

    const applicantUser = await this.prisma.user.findUnique({
      where: {
        id: application.userId,
      },
      include: {
        profile: true,
      },
    });

    if (!applicantUser) {
      throw new NotFoundException(
        "This creator application is no longer valid because the applicant account no longer exists.",
      );
    }

    if (application.status === "APPROVED" && applicantUser.role === "CREATOR") {
      return {
        application: this.mapApplication(
          {
            ...application,
            user: applicantUser,
          },
          {
            includeApplicant: true,
          },
        ),
        message: "Creator application is already approved.",
      };
    }

    if (applicantUser.role !== "READER") {
      throw new BadRequestException(
        "Only reader accounts can be approved through the creator application flow.",
      );
    }

    const reviewedAt = new Date();
    const revenueShareApproved = input.approveRevenueShareContract ?? true;
    const [, approvedApplication] = await this.prisma.$transaction([
      this.prisma.user.update({
        where: {
          id: application.userId,
        },
        data: {
          role: "CREATOR",
        },
      }),
      this.prisma.creatorApplication.update({
        where: {
          id: applicationId,
        },
        data: {
          revenueShareContractApproved: revenueShareApproved,
          reviewNotes: input.reviewNotes,
          reviewedAt,
          reviewedByUserId: reviewerUserId,
          status: "APPROVED",
          submittedAt: application.submittedAt ?? reviewedAt,
        },
        include: {
          reviewedByUser: {
            include: {
              profile: true,
            },
          },
        },
      }),
    ]);

    await this.prisma.adminAuditLog.create({
      data: {
        action: "Creator application approved",
        adminUserId: reviewerUserId,
        detail: `${approvedApplication.fullName} was approved for creator studio access${
          revenueShareApproved
            ? " with revenue-sharing contract eligibility."
            : " without revenue-sharing contract eligibility (studio only)."
        }`,
        icon: "verified",
        summary: `Approved ${approvedApplication.fullName}`,
        targetId: approvedApplication.id,
        targetType: "CREATOR_APPLICATION",
        tone: "emerald",
      },
    });

    const frontendBase = env.frontendAppUrl?.replace(/\/$/, "").trim() || null;
    const studioDashboardUrl = frontendBase ? `${frontendBase}/creator/dashboard` : null;

    try {
      await this.resendEmailService.sendCreatorApplicationApproved({
        applicantName: approvedApplication.fullName,
        email: approvedApplication.email.trim(),
        primaryGenre: approvedApplication.primaryGenre,
        revenueShareEligible: revenueShareApproved,
        reviewNotesFromTeam: input.reviewNotes,
        reviewedAt,
        studioDashboardUrl,
      });
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          applicantUserId: application.userId,
          applicationId: approvedApplication.id,
          email: approvedApplication.email,
          event: "creator_application_approval_email_failed",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }

    return {
      application: this.mapApplication(
        {
          ...approvedApplication,
          user: {
            ...applicantUser,
            role: "CREATOR",
          },
        },
        {
          includeApplicant: true,
        },
      ),
      message: revenueShareApproved
        ? "Creator approved with studio access and revenue-sharing eligibility."
        : "Creator approved for studio access only (no revenue-sharing contracts).",
    };
  }

  async rejectApplication(
    applicationId: string,
    reviewerUserId: string,
    input: ReviewCreatorApplicationInput,
  ) {
    const application = await this.prisma.creatorApplication.findUnique({
      where: {
        id: applicationId,
      },
      include: {
        reviewedByUser: {
          include: {
            profile: true,
          },
        },
      },
    });

    if (!application) {
      throw new NotFoundException("Creator application not found.");
    }

    const applicantUser = await this.prisma.user.findUnique({
      where: {
        id: application.userId,
      },
      include: {
        profile: true,
      },
    });

    if (!applicantUser) {
      throw new NotFoundException(
        "This creator application is no longer valid because the applicant account no longer exists.",
      );
    }

    if (application.status === "APPROVED") {
      throw new BadRequestException(
        "Approved creator applications cannot be rejected.",
      );
    }

    if (application.status === "REJECTED") {
      return {
        application: this.mapApplication(
          {
            ...application,
            user: applicantUser,
          },
          {
            includeApplicant: true,
          },
        ),
        message: "Creator application is already rejected.",
      };
    }

    const reviewedAt = new Date();
    const rejectedApplication = await this.prisma.creatorApplication.update({
      where: {
        id: applicationId,
      },
      data: {
        reviewNotes: input.reviewNotes,
        reviewedAt,
        reviewedByUserId: reviewerUserId,
        status: "REJECTED",
      },
      include: {
        reviewedByUser: {
          include: {
            profile: true,
          },
        },
      },
    });

    await this.prisma.adminAuditLog.create({
      data: {
        action: "Creator application rejected",
        adminUserId: reviewerUserId,
        detail: `${rejectedApplication.fullName} was rejected from the creator review queue.`,
        icon: "gavel",
        summary: `Rejected ${rejectedApplication.fullName}`,
        targetId: rejectedApplication.id,
        targetType: "CREATOR_APPLICATION",
        tone: "rose",
      },
    });

    return {
      application: this.mapApplication(
        {
          ...rejectedApplication,
          user: applicantUser,
        },
        {
          includeApplicant: true,
        },
      ),
      message: "Creator application rejected.",
    };
  }

  private async getActiveUser(
    userId: string,
    options: { includeProfile?: boolean } = {},
  ) {
    const user = await this.prisma.user.findUnique({
      where: {
        id: userId,
      },
      include: {
        profile: options.includeProfile ?? false,
      },
    });

    if (!user || user.status !== "ACTIVE") {
      throw new UnauthorizedException("The current user account is unavailable.");
    }

    return user;
  }

  private mapApplication(
    application: {
      id: string;
      createdAt: Date;
      email: string;
      experience: string;
      fullName: string;
      motivation: string;
      portfolioUrl: string | null;
      primaryGenre: string;
      requestedContractType: ContractExclusivity | null;
      reviewedAt: Date | null;
      reviewedByUser?: {
        profile: {
          displayName: string;
        } | null;
      } | null;
      reviewNotes: string | null;
      status: CreatorApplicationStatus;
      submittedAt: Date | null;
      updatedAt: Date;
      wantsContract: boolean;
      revenueShareContractApproved: boolean | null;
      user?: {
        email: string | null;
        id: string;
        profile: {
          displayName: string;
        } | null;
        role: string;
      };
      userId?: string;
    },
    options: { includeApplicant?: boolean } = {},
  ) {
    return {
      id: application.id,
      fullName: application.fullName,
      email: application.email,
      primaryGenre: application.primaryGenre,
      experience: application.experience,
      portfolioUrl: application.portfolioUrl,
      motivation: application.motivation,
      requestedContractType: application.wantsContract
        ? application.requestedContractType
        : null,
      status: application.status,
      submittedAt: application.submittedAt,
      reviewedAt: application.reviewedAt,
      reviewNotes: application.reviewNotes,
      createdAt: application.createdAt,
      updatedAt: application.updatedAt,
      wantsContract: application.wantsContract,
      revenueShareContractApproved:
        application.status === "APPROVED"
          ? (application.revenueShareContractApproved ?? true)
          : null,
      reviewedBy: application.reviewedAt
        ? application.reviewedByUser?.profile?.displayName ?? "TaleStead Admin"
        : null,
      ...(options.includeApplicant
        ? {
            applicant: application.user
              ? {
                  id: application.user.id,
                  displayName:
                    application.user.profile?.displayName ?? application.fullName,
                  email: application.user.email!,
                  role: application.user.role,
                }
              : {
                  id: application.userId ?? "",
                  displayName: application.fullName,
                  email: application.email,
                  role: "READER",
                },
          }
        : {}),
    };
  }

  private async getCreatorContractTerms() {
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

    const settingsByKey = new Map(settings.map((setting) => [setting.key, setting]));
    const exclusivePercent =
      settingsByKey.get(creatorExclusiveRevenueShareSettingKey)?.valueCents ??
      getDefaultCreatorRevenueSharePercent(ContractExclusivity.EXCLUSIVE);
    const nonExclusivePercent =
      settingsByKey.get(creatorNonExclusiveRevenueShareSettingKey)?.valueCents ??
      getDefaultCreatorRevenueSharePercent(ContractExclusivity.NON_EXCLUSIVE);

    return {
      exclusive: {
        contractType: ContractExclusivity.EXCLUSIVE,
        label: "Exclusive",
        revenueSharePercent: exclusivePercent,
      },
      nonExclusive: {
        contractType: ContractExclusivity.NON_EXCLUSIVE,
        label: "Non-Exclusive",
        revenueSharePercent: nonExclusivePercent,
      },
    };
  }
}
