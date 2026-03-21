import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const response = http.getResponse<any>();
    const request = http.getRequest<any>();

    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = "Internal server error";
    let retryAfterSeconds: number | null = null;

    if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const payload = exception.getResponse();

      if (typeof payload === "string") {
        message = payload;
      } else if (typeof payload === "object" && payload !== null) {
        const typedPayload = payload as {
          message?: string | string[];
          retryAfterSeconds?: number;
        };
        const candidate = typedPayload.message;

        if (Array.isArray(candidate)) {
          message = candidate.join(", ");
        } else if (typeof candidate === "string") {
          message = candidate;
        }

        if (
          typeof typedPayload.retryAfterSeconds === "number" &&
          typedPayload.retryAfterSeconds > 0
        ) {
          retryAfterSeconds = Math.ceil(typedPayload.retryAfterSeconds);
        }
      }
    }

    const path = request?.url ?? "unknown";
    const method = request?.method ?? "UNKNOWN";

    if (statusCode >= 500) {
      this.logger.error(`${method} ${path} -> ${statusCode}`, exception as Error);
    } else {
      this.logger.warn(`${method} ${path} -> ${statusCode} ${message}`);
    }

    if (retryAfterSeconds) {
      response.header("Retry-After", String(retryAfterSeconds));
    }

    response.status(statusCode).send({
      statusCode,
      message,
      path,
      retryAfterSeconds,
      timestamp: new Date().toISOString(),
      requestId: request?.id ?? null,
    });
  }
}
