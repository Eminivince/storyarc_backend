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
import { SkipThrottle, Throttle } from "@nestjs/throttler";
import { AccessTokenGuard } from "../common/guards/access-token.guard";
import { AuthenticatedRequest } from "../common/types/request-with-auth.type";
import {
  throttlePayment,
  throttleRefund,
  throttleUnlock,
} from "../common/throttler/throttler.constants";
import {
  parseConfirmCheckoutSessionBody,
  parseCreateCheckoutSessionBody,
  parseRefundRequestBody,
  parseSendGiftBody,
  parseSubscriptionChangePlanBody,
  parseUnlockChapterBatchBody,
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

  @Get("purchases")
  async getPurchases(@Req() request: AuthenticatedRequest) {
    return this.monetizationService.getPurchases(request.auth!.userId);
  }

  @Throttle(throttlePayment)
  @Post("checkout-session")
  async createCheckoutSession(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.monetizationService.createCheckoutSession(
      request.auth!.userId,
      parseCreateCheckoutSessionBody(body),
      request,
    );
  }

  @Throttle(throttlePayment)
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

  @Throttle(throttleUnlock)
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

  @Get("chapters/:storySlug/:chapterSlug/batch-options")
  async getChapterBatchUnlockOptions(
    @Param("chapterSlug") chapterSlug: string,
    @Param("storySlug") storySlug: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.monetizationService.getChapterBatchUnlockOptions(
      request.auth!.userId,
      { chapterSlug, storySlug },
    );
  }

  @Throttle(throttleUnlock)
  @Post("chapters/:storySlug/:chapterSlug/unlock-batch")
  async unlockChapterBatchWithCoins(
    @Body() body: unknown,
    @Param("chapterSlug") chapterSlug: string,
    @Param("storySlug") storySlug: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.monetizationService.unlockChapterBatchWithCoins(
      request.auth!.userId,
      parseUnlockChapterBatchBody(body, { chapterSlug, storySlug }),
    );
  }

  @Throttle(throttlePayment)
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

  @Throttle(throttleRefund)
  @Post("refund-request")
  async requestRefund(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const { purchaseId, reason } = parseRefundRequestBody(body);
    return this.monetizationService.requestRefund(
      request.auth!.userId,
      purchaseId,
      reason,
    );
  }

  @Throttle(throttlePayment)
  @Post("subscription/cancel")
  async cancelSubscription(@Req() request: AuthenticatedRequest) {
    return this.monetizationService.cancelSubscription(request.auth!.userId);
  }

  @Throttle(throttlePayment)
  @Post("subscription/change-plan")
  async changeSubscriptionPlan(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const { planId, billingInterval } = parseSubscriptionChangePlanBody(body);
    return this.monetizationService.changeSubscriptionPlan(
      request.auth!.userId,
      planId,
      billingInterval,
    );
  }
}

@Controller("monetization/paystack")
export class PaystackWebhookController {
  constructor(private readonly monetizationService: MonetizationService) {}

  @SkipThrottle()
  @Post("webhook")
  async handleWebhook(
    @Headers("x-paystack-signature") signature: string | undefined,
    @RawBody() rawBody: Buffer | undefined,
  ) {
    return this.monetizationService.handlePaystackWebhook(rawBody, signature);
  }
}

@Controller("monetization/cryptomus")
export class CryptomusWebhookController {
  constructor(private readonly monetizationService: MonetizationService) {}

  @SkipThrottle()
  @Post("webhook")
  async handleWebhook(@RawBody() rawBody: Buffer | undefined) {
    return this.monetizationService.handleCryptomusWebhook(rawBody);
  }
}

@Controller("monetization/flutterwave")
export class FlutterwaveWebhookController {
  constructor(private readonly monetizationService: MonetizationService) {}

  @SkipThrottle()
  @Post("webhook")
  async handleWebhook(
    @Headers("flutterwave-signature") signature: string | undefined,
    @Headers("verif-hash") verifHash: string | undefined,
    @RawBody() rawBody: Buffer | undefined,
  ) {
    return this.monetizationService.handleFlutterwaveWebhook(
      rawBody,
      signature,
      verifHash,
    );
  }
}
