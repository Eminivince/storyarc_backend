export type StudioStoryInput = {
  audience: string;
  coverImage: string;
  genre: string;
  synopsis: string;
  tags: string[];
  title: string;
};

export type StudioChapterDraftInput = {
  arcId: string | null;
  authorsNote: string;
  body: string;
  chapterId: string | null;
  coinUnlockPrice: number;
  number: string;
  publishType: "now" | "scheduled";
  premiumEnabled: boolean;
  scheduledFor: string | null;
  title: string;
  volumeId: string | null;
  warnings: string[];
};

export type StudioPublishInput = {
  mode: "now" | "scheduled";
  scheduledFor: string | null;
};

export type StudioStructureInput = {
  volumes: Array<{
    arcs: Array<{
      id: string | null;
      sortOrder: number;
      status: string;
      title: string;
    }>;
    id: string | null;
    number: number;
    sortOrder: number;
    status: string;
    title: string;
  }>;
};

export type StudioCoverUploadInput = {
  base64: string;
  contentType: string;
  filename: string;
};
