import { BadRequestException, Injectable } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as OTPAuth from "otpauth";
import { PrismaService } from "../database/prisma.service";
import { env } from "../config/env";

@Injectable()
export class TotpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  async setup(userId: string) {
    const existing = await this.prisma.totpCredential.findUnique({
      where: { userId },
    });

    if (existing?.verified) {
      throw new BadRequestException("Two-factor authentication is already enabled.");
    }

    const secret = new OTPAuth.Secret({ size: 20 });

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true },
    });

    const totp = new OTPAuth.TOTP({
      issuer: "TaleStead",
      label: user.email,
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret,
    });

    await this.prisma.totpCredential.upsert({
      where: { userId },
      create: {
        userId,
        encryptedSecret: secret.base32,
        verified: false,
      },
      update: {
        encryptedSecret: secret.base32,
        verified: false,
        enabledAt: null,
      },
    });

    return {
      qrUri: totp.toString(),
      secret: secret.base32,
    };
  }

  async verifySetup(userId: string, code: string) {
    const credential = await this.prisma.totpCredential.findUnique({
      where: { userId },
    });

    if (!credential) {
      throw new BadRequestException("Please set up 2FA first.");
    }

    if (credential.verified) {
      throw new BadRequestException("Two-factor authentication is already enabled.");
    }

    if (!this.verifyCode(credential.encryptedSecret, code)) {
      throw new BadRequestException("Invalid verification code.");
    }

    await this.prisma.totpCredential.update({
      where: { userId },
      data: { verified: true, enabledAt: new Date() },
    });

    return { message: "Two-factor authentication enabled." };
  }

  async generateChallengeToken(userId: string): Promise<string> {
    return this.jwtService.signAsync(
      { sub: userId, type: "2fa-challenge" },
      { secret: env.jwtAccessSecret, expiresIn: "5m" },
    );
  }

  async verifyChallenge(challengeToken: string, code: string) {
    let payload: { sub: string; type: string };

    try {
      payload = await this.jwtService.verifyAsync(challengeToken, {
        secret: env.jwtAccessSecret,
      });
    } catch {
      throw new BadRequestException("Challenge token is invalid or expired.");
    }

    if (payload.type !== "2fa-challenge") {
      throw new BadRequestException("Invalid challenge token type.");
    }

    const credential = await this.prisma.totpCredential.findUnique({
      where: { userId: payload.sub },
    });

    if (!credential?.verified) {
      throw new BadRequestException("Two-factor authentication is not enabled.");
    }

    if (!this.verifyCode(credential.encryptedSecret, code)) {
      throw new BadRequestException("Invalid verification code.");
    }

    return payload.sub;
  }

  async disable(userId: string, password: string, code: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { credential: true },
    });

    if (!user.credential) {
      throw new BadRequestException("No password credential found.");
    }

    const { compare } = await import("bcryptjs");
    const passwordMatches = await compare(password, user.credential.passwordHash);

    if (!passwordMatches) {
      throw new BadRequestException("Invalid password.");
    }

    const totpCredential = await this.prisma.totpCredential.findUnique({
      where: { userId },
    });

    if (!totpCredential?.verified) {
      throw new BadRequestException("Two-factor authentication is not enabled.");
    }

    if (!this.verifyCode(totpCredential.encryptedSecret, code)) {
      throw new BadRequestException("Invalid verification code.");
    }

    await this.prisma.totpCredential.delete({ where: { userId } });

    return { message: "Two-factor authentication disabled." };
  }

  async isEnabled(userId: string): Promise<boolean> {
    const credential = await this.prisma.totpCredential.findUnique({
      where: { userId },
      select: { verified: true },
    });

    return credential?.verified === true;
  }

  private verifyCode(base32Secret: string, code: string): boolean {
    const totp = new OTPAuth.TOTP({
      secret: OTPAuth.Secret.fromBase32(base32Secret),
      algorithm: "SHA1",
      digits: 6,
      period: 30,
    });

    const delta = totp.validate({ token: code, window: 1 });
    return delta !== null;
  }
}
