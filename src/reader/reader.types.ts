export type UpdateReadingProgressInput = {
  chapterSlug: string;
  paragraphIndex: number;
  progressPercent: number;
  storySlug: string;
};

export type CreateBookmarkInput = {
  chapterSlug: string;
  storySlug: string;
};
