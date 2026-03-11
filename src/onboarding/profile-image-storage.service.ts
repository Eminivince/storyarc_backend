import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createHash } from "crypto";
import { env } from "../config/env";

const MAX_PROFILE_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;

type UploadProfilePictureInput = {
  base64: string;
  contentType: string;
  filename: string;
  userId: string;
};

type CloudinaryUploadResponse = {
  error?: {
    message?: string;
  };
  secure_url?: string;
};

@Injectable()
export class ProfileImageStorageService {
  private readonly logger = new Logger(ProfileImageStorageService.name);

  async uploadProfilePicture(input: UploadProfilePictureInput) {
    if (
      !env.cloudinaryCloudName ||
      !env.cloudinaryApiKey ||
      !env.cloudinaryApiSecret
    ) {
      throw new ServiceUnavailableException(
        "Profile picture uploads are not configured.",
      );
    }

    if (!input.contentType.startsWith("image/")) {
      throw new BadRequestException("Profile pictures must be valid images.");
    }

    const sanitizedBase64 = input.base64.replace(/\s+/g, "");
    const approximateSize = Buffer.byteLength(sanitizedBase64, "base64");

    if (!sanitizedBase64 || approximateSize === 0) {
      throw new BadRequestException("Profile picture data is empty.");
    }

    if (approximateSize > MAX_PROFILE_IMAGE_SIZE_BYTES) {
      throw new BadRequestException("Profile pictures must be 5 MB or smaller.");
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const publicId = `${this.getProfileImageFolder()}/${input.userId}`;
    const signature = this.signUploadParams({
      invalidate: "true",
      overwrite: "true",
      public_id: publicId,
      timestamp: String(timestamp),
    });
    const form = new FormData();

    form.append("api_key", env.cloudinaryApiKey);
    form.append("file", `data:${input.contentType};base64,${sanitizedBase64}`);
    form.append("invalidate", "true");
    form.append("overwrite", "true");
    form.append("public_id", publicId);
    form.append("signature", signature);
    form.append("timestamp", String(timestamp));

    let response: Response;

    try {
      response = await fetch(
        `https://api.cloudinary.com/v1_1/${env.cloudinaryCloudName}/image/upload`,
        {
          body: form,
          method: "POST",
        },
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unexpected upload transport failure.";

      this.logger.error(
        `Cloudinary profile upload request failed for user=${input.userId} file=${input.filename}: ${message}`,
      );

      throw new BadGatewayException("Profile picture upload failed.");
    }

    const payload = (await response.json().catch(() => null)) as
      | CloudinaryUploadResponse
      | null;

    if (!response.ok || !payload?.secure_url) {
      this.logger.warn(
        `Cloudinary profile upload failed for user=${input.userId} file=${input.filename} status=${response.status} message=${payload?.error?.message ?? "unknown"}`,
      );

      throw new BadGatewayException("Profile picture upload failed.");
    }

    return payload.secure_url;
  }

  private getProfileImageFolder() {
    return (env.cloudinaryProfileImageFolder ?? "storyarc/profile-pictures")
      .trim()
      .replace(/^\/+|\/+$/g, "");
  }

  private signUploadParams(params: Record<string, string>) {
    const signatureBase = Object.entries(params)
      .filter(([, value]) => value)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, value]) => `${key}=${value}`)
      .join("&");

    return createHash("sha1")
      .update(`${signatureBase}${env.cloudinaryApiSecret}`)
      .digest("hex");
  }
}
