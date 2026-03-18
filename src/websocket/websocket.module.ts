import { Global, Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { WebsocketGateway } from "./websocket.gateway";
import { WebsocketService } from "./websocket.service";

@Global()
@Module({
  imports: [JwtModule.register({})],
  providers: [WebsocketGateway, WebsocketService],
  exports: [WebsocketService],
})
export class WebsocketModule {}
