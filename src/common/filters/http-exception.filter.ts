import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";

function isLikelyClientStreamAbort(exception: unknown): boolean {
  if (!exception || typeof exception !== "object") {
    return false;
  }

  const err = exception as NodeJS.ErrnoException & { message?: string };

  return (
    err.code === "ERR_STREAM_PREMATURE_CLOSE" ||
    err.code === "ERR_STREAM_PREMATURE_CLIENT_CLOSE" ||
    err.code === "ECONNRESET" ||
    err.code === "EPIPE" ||
    err.code === "ECANCELED" ||
    err.message === "Premature close"
  );
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const response = http.getResponse<any>();
    const request = http.getRequest<any>();
    const path = request?.url ?? "unknown";
    const method = request?.method ?? "UNKNOWN";

    const responseAlreadyCommitted =
      Boolean(response?.sent) || Boolean(response?.raw?.headersSent);

    if (responseAlreadyCommitted) {
      if (isLikelyClientStreamAbort(exception)) {
        this.logger.warn(
          `${method} ${path}: client closed connection while response was sending`,
          exception as Error,
        );
      } else {
        this.logger.warn(
          `${method} ${path}: error after headers sent (not sending another body)`,
          exception as Error,
        );
      }
      return;
    }

    if (isLikelyClientStreamAbort(exception)) {
      this.logger.warn(
        `${method} ${path}: client disconnected before response completed`,
        exception as Error,
      );
      return;
    }

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
