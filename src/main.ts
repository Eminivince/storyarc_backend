import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "./app.module";
import { HttpExceptionFilter } from "./common/filters/http-exception.filter";
import { RequestLoggingInterceptor } from "./common/interceptors/request-logging.interceptor";
import { env } from "./config/env";
import { PrismaService } from "./database/prisma.service";

const logger = new Logger("Bootstrap");

async function bootstrap() {
  logger.log("Starting Nest application...");
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      logger: false,
    }),
    {
      rawBody: true,
    },
  );

  const prisma = app.get(PrismaService);
  prisma.enableShutdownHooks(app);

  app.enableCors({
    origin: true,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
    allowedHeaders: ["Content-Type", "Authorization", "Accept"],
  });
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new RequestLoggingInterceptor());

  await app.listen(env.port, "0.0.0.0");

  logger.log(`StoryArc backend listening on port ${env.port}`);
}

bootstrap().catch((error) => {
  logger.error(
    "Failed to start StoryArc backend",
    error instanceof Error ? error.stack : String(error),
  );
  process.exit(1);
});
