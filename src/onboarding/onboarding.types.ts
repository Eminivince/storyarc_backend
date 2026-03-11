import { ReadingStyle, ReadingTheme } from "../auth/auth.types";

export type UpdateOnboardingGenresInput = {
  genres: string[];
};

export type UpdateOnboardingPreferencesInput = {
  readingStyle: ReadingStyle;
  readingTheme: ReadingTheme;
};

export type UploadOnboardingProfilePictureInput = {
  base64: string;
  contentType: string;
  filename: string;
};
