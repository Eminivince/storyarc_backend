import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const role = request.auth?.role;

    if (role !== "ADMIN") {
      throw new ForbiddenException("Admin access is required.");
    }

    return true;
  }
}
