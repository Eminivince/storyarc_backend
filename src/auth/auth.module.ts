import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { AccessTokenGuard } from "../common/guards/access-token.guard";
import { env } from "../config/env";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { AuthTestSupportController } from "./auth-test-support.controller";
import { AuthThrottleService } from "./auth-throttle.service";
import { MeController } from "./me.controller";
import { ResendEmailService } from "./resend-email.service";
import { TotpService } from "./totp.service";

@Module({
  imports: [JwtModule.register({})],
  controllers: env.authTestSupportEnabled
    ? [AuthController, MeController, AuthTestSupportController]
    : [AuthController, MeController],
  providers: [
    AuthService,
    AuthThrottleService,
    AccessTokenGuard,
    ResendEmailService,
    TotpService,
  ],
  exports: [
    AuthService,
    AuthThrottleService,
    AccessTokenGuard,
    JwtModule,
    ResendEmailService,
    TotpService,
  ],
})
export class AuthModule {}
