import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import { AccessTokenGuard } from "../../common/guards/access-token.guard";
import { AuthenticatedRequest } from "../../common/types/request-with-auth.type";
import {
  parseAdminContractBody,
  parseContractTemplateBody,
} from "../../operations/operations.schemas";
import { AdminGuard } from "../guards/admin.guard";
import { PermissionGuard } from "../guards/permission.guard";
import { AdminContractsService } from "./admin-contracts.service";

@Controller("admin")
@UseGuards(AccessTokenGuard, AdminGuard, PermissionGuard)
export class AdminContractsController {
  constructor(private readonly service: AdminContractsService) {}

  @Get("contracts/lookups")
  async getAdminContractLookups(@Req() request: AuthenticatedRequest) {
    return this.service.getAdminContractLookups(request.auth!.userId, {
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"] as string | undefined,
    });
  }

  @Get("contracts/templates")
  async getAdminContractTemplates(@Req() request: AuthenticatedRequest) {
    return this.service.listAdminContractTemplates(request.auth!.userId, {
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"] as string | undefined,
    });
  }

  @Get("contracts/templates/:templateId")
  async getAdminContractTemplate(
    @Param("templateId") templateId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.getAdminContractTemplate(
      request.auth!.userId,
      templateId,
      {
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] as string | undefined,
      },
    );
  }

  @Post("contracts/templates")
  async createAdminContractTemplate(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.createAdminContractTemplate(
      request.auth!.userId,
      parseContractTemplateBody(body),
      {
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] as string | undefined,
      },
    );
  }

  @Put("contracts/templates/:templateId")
  async updateAdminContractTemplate(
    @Param("templateId") templateId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.updateAdminContractTemplate(
      request.auth!.userId,
      templateId,
      parseContractTemplateBody(body),
      {
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] as string | undefined,
      },
    );
  }

  @Get("contracts")
  async getAdminContracts(@Req() request: AuthenticatedRequest) {
    return this.service.listAdminContracts(request.auth!.userId, {
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"] as string | undefined,
    });
  }

  @Get("contracts/:contractId")
  async getAdminContract(
    @Param("contractId") contractId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.getAdminContract(
      request.auth!.userId,
      contractId,
      {
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] as string | undefined,
      },
    );
  }

  @Post("contracts")
  async createAdminContract(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.createAdminContract(
      request.auth!.userId,
      parseAdminContractBody(body),
      {
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] as string | undefined,
      },
    );
  }

  @Put("contracts/:contractId")
  async updateAdminContract(
    @Param("contractId") contractId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.updateAdminContract(
      request.auth!.userId,
      contractId,
      parseAdminContractBody(body),
      {
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] as string | undefined,
      },
    );
  }
}
