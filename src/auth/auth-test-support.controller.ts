import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Query,
} from "@nestjs/common";
import { env } from "../config/env";
import { ResendEmailService } from "./resend-email.service";

@Controller("test-support/auth")
export class AuthTestSupportController {
  constructor(private readonly resendEmailService: ResendEmailService) {}

  @Get("registration-code")
  getRegistrationCode(@Query("email") email: string | undefined) {
    this.assertEnabled();

    if (!email?.trim()) {
      throw new BadRequestException("email is required.");
    }

    const capturedCode = this.resendEmailService.getCapturedRegistrationCode(email);

    if (!capturedCode) {
      throw new NotFoundException("No captured registration code was found.");
    }

    return capturedCode;
  }

  private assertEnabled() {
    if (!env.authTestSupportEnabled) {
      throw new NotFoundException();
    }
  }
}
