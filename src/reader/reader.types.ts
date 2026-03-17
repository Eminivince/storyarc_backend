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

export const READING_LIST_VISIBILITIES = ["private", "public"] as const;

export type ReadingListVisibilityInput =
  (typeof READING_LIST_VISIBILITIES)[number];

export type CreateReadingListInput = {
  description: string | null;
  name: string;
  visibility: ReadingListVisibilityInput;
};

export type UpdateReadingListInput = {
  description: string | null;
  name: string;
  visibility: ReadingListVisibilityInput;
};

export type AddStoryToReadingListInput = {
  storySlug: string;
};

export type UpdateStoryRatingInput = {
  rating: number;
};

export type CommentSort = "top" | "newest";

export type CreateCommentInput = {
  body: string;
  parentCommentId: string | null;
};

export type UpdateCommentInput = {
  body: string;
};

export type ReviewSort = "recent" | "highest" | "lowest" | "most_helpful";

export type StoryRankingKindInput =
  | "trending"
  | "popular"
  | "top-rated"
  | "rising";

export type UpsertReviewInput = {
  body: string;
  containsSpoilers: boolean;
  rating: number;
  title: string | null;
};

export type StoryRankingsQueryInput = {
  genre: string | null;
  kind: StoryRankingKindInput;
  limit: number | null;
};

export type ReaderCommentNode = {
  author: {
    avatarUrl: string | null;
    displayName: string;
    id: string;
  };
  body: string;
  canDelete: boolean;
  canEdit: boolean;
  createdAt: Date;
  createdAtLabel: string;
  editedAt: Date | null;
  editedLabel: string | null;
  id: string;
  isOwner: boolean;
  isRemoved: boolean;
  isReply: boolean;
  replyCount: number;
  replies: ReaderCommentNode[];
};
