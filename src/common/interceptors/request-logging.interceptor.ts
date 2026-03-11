import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from "@nestjs/common";
import { Observable, tap } from "rxjs";

@Injectable()
export class RequestLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger("HTTP");

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<any>();
    const response = http.getResponse<any>();
    const startedAt = Date.now();

    return next.handle().pipe(
      tap(() => {
        const statusCode = response?.statusCode ?? 200;
        const durationMs = Date.now() - startedAt;
        const requestId = request?.id ?? "n/a";
        const userId = request?.auth?.userId ?? "anonymous";

        this.logger.log(
          `${request?.method ?? "UNKNOWN"} ${request?.url ?? "unknown"} ${statusCode} ${durationMs}ms reqId=${requestId} user=${userId}`,
        );
      }),
    );
  }
}
