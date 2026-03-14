import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "./app.module";
import { HttpExceptionFilter } from "./common/filters/http-exception.filter";
import { RequestLoggingInterceptor } from "./common/interceptors/request-logging.interceptor";
import { edgeCacheControlMiddleware } from "./common/middleware/edge-cache-control.middleware";
import { env } from "./config/env";
import { PrismaService } from "./database/prisma.service";

const logger = new Logger("Bootstrap");
const explicitAllowedOrigins = new Set(
  [
    env.frontendAppUrl,
    "https://fractalholding.com",
    "https://www.fractalholding.com",
    "https://www.talestead.vercel.app",
  ]
    .map(normalizeOrigin)
    .filter((origin): origin is string => Boolean(origin)),
);

function normalizeOrigin(origin: string | null | undefined) {
  if (!origin) {
    return null;
  }

  try {
    return new URL(origin).origin;
  } catch {
    return null;
  }
}

function isLocalDevelopmentOrigin(origin: string) {
  const normalizedOrigin = normalizeOrigin(origin);

  if (!normalizedOrigin) {
    return false;
  }

  const { hostname } = new URL(normalizedOrigin);

  return hostname === "localhost" || hostname === "127.0.0.1";
}

function isAllowedCorsOrigin(origin: string | undefined) {
  if (!origin) {
    return true;
  }

  const normalizedOrigin = normalizeOrigin(origin);

  if (!normalizedOrigin) {
    return false;
  }

  if (explicitAllowedOrigins.has(normalizedOrigin)) {
    return true;
  }

  if (env.nodeEnv !== "production" && isLocalDevelopmentOrigin(normalizedOrigin)) {
    return true;
  }

  return false;
}

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
    origin: (origin, callback) => {
      callback(null, isAllowedCorsOrigin(origin ?? undefined));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
    allowedHeaders: ["Content-Type", "Authorization", "Accept"],
  });
  app
    .getHttpAdapter()
    .getInstance()
    .addHook("onSend", edgeCacheControlMiddleware);
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new RequestLoggingInterceptor());

  await app.listen(env.port, "0.0.0.0");

  logger.log(`TaleStead backend listening on port ${env.port}`);
}

bootstrap().catch((error) => {
  logger.error(
    "Failed to start TaleStead backend",
    error instanceof Error ? error.stack : String(error),
  );
  process.exit(1);
});
