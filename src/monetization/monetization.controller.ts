import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  RawBody,
  Req,
  UseGuards,
  Headers,
} from "@nestjs/common";
import { AccessTokenGuard } from "../common/guards/access-token.guard";
import { AuthenticatedRequest } from "../common/types/request-with-auth.type";
import {
  parseConfirmCheckoutSessionBody,
  parseCreateCheckoutSessionBody,
  parseSendGiftBody,
  parseUnlockChapterBody,
} from "./monetization.schemas";
import { MonetizationService } from "./monetization.service";

@Controller("monetization")
@UseGuards(AccessTokenGuard)
export class MonetizationController {
  constructor(private readonly monetizationService: MonetizationService) {}

  @Get("catalog")
  async getCatalog() {
    return this.monetizationService.getCatalog();
  }

  @Get("status")
  async getStatus(@Req() request: AuthenticatedRequest) {
    return this.monetizationService.getStatus(request.auth!.userId);
  }

  @Post("checkout-session")
  async createCheckoutSession(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.monetizationService.createCheckoutSession(
      request.auth!.userId,
      parseCreateCheckoutSessionBody(body),
    );
  }

  @Post("checkout-session/confirm")
  async confirmCheckoutSession(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.monetizationService.confirmCheckoutSession(
      request.auth!.userId,
      parseConfirmCheckoutSessionBody(body),
    );
  }

  @Post("chapters/:storySlug/:chapterSlug/unlock-with-coins")
  async unlockChapterWithCoins(
    @Body() body: unknown,
    @Param("chapterSlug") chapterSlug: string,
    @Param("storySlug") storySlug: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.monetizationService.unlockChapterWithCoins(
      request.auth!.userId,
      parseUnlockChapterBody(body, { chapterSlug, storySlug }),
    );
  }

  @Post("chapters/:storySlug/:chapterSlug/unlock-with-ad")
  async unlockChapterWithAd(
    @Body() body: unknown,
    @Param("chapterSlug") chapterSlug: string,
    @Param("storySlug") storySlug: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.monetizationService.unlockChapterWithAd(
      request.auth!.userId,
      parseUnlockChapterBody(body, { chapterSlug, storySlug }),
    );
  }

  @Post("gifts")
  async sendGift(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.monetizationService.sendGift(
      request.auth!.userId,
      parseSendGiftBody(body),
    );
  }
}

@Controller("monetization/paystack")
export class PaystackWebhookController {
  constructor(private readonly monetizationService: MonetizationService) {}

  @Post("webhook")
  async handleWebhook(
    @Headers("x-paystack-signature") signature: string | undefined,
    @RawBody() rawBody: Buffer | undefined,
  ) {
    return this.monetizationService.handlePaystackWebhook(rawBody, signature);
  }
}
