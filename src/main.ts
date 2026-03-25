import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import compress from "@fastify/compress";
import helmet from "@fastify/helmet";
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
    "http://localhost:4173",
    "https://fractalholding.com",
    "https://www.fractalholding.com",
    "https://www.talestead.com",
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
    return env.nodeEnv !== "production";
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

  const adapter = new FastifyAdapter({ logger: false });
  const fastifyInstance = adapter.getInstance();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    adapter,
    {
      rawBody: true,
    },
  );

  const prisma = app.get(PrismaService);
  prisma.enableShutdownHooks(app);

  // Security headers via Helmet — register before CORS
  await app.register(helmet, {
    contentSecurityPolicy: false,
    hsts: { maxAge: 31536000, includeSubDomains: true },
    frameguard: { action: "deny" },
  });

  app.enableCors({
    origin: (origin, callback) => {
      callback(null, isAllowedCorsOrigin(origin ?? undefined));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
    allowedHeaders: ["Content-Type", "Authorization", "Accept"],
    exposedHeaders: ["Retry-After"],
  });
  // Enable HTTP compression globally (gzip/deflate) via Fastify plugin.
  // @fastify/compress@7 is compatible with Fastify 5.x (used by Nest 11).
  await app.register(compress, {
    global: true,
  });

  fastifyInstance.addHook("onSend", edgeCacheControlMiddleware);
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
