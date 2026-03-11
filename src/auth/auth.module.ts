import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { AccessTokenGuard } from "../common/guards/access-token.guard";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { MeController } from "./me.controller";
import { ResendEmailService } from "./resend-email.service";

@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController, MeController],
  providers: [AuthService, AccessTokenGuard, ResendEmailService],
  exports: [AuthService, AccessTokenGuard, JwtModule, ResendEmailService],
})
export class AuthModule {}
