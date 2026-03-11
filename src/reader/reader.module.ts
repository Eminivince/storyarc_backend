import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { MonetizationModule } from "../monetization/monetization.module";
import { ReaderController } from "./reader.controller";
import { ReaderPublicController } from "./reader.public.controller";
import { ReaderService } from "./reader.service";

@Module({
  imports: [AuthModule, MonetizationModule],
  controllers: [ReaderController, ReaderPublicController],
  providers: [ReaderService],
})
export class ReaderModule {}
