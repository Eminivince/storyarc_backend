/**
 * Canonical fiction genres for TaleStead (DB seed, reader APIs, display labels).
 * Order is preserved for Explore / browse UIs unless sorted alphabetically by caller.
 */
export type StoryGenreDefinition = {
  description: string;
  name: string;
  slug: string;
};

export const STORY_GENRES: StoryGenreDefinition[] = [
  { slug: "romance", name: "Romance", description: "Relationships, tension, and emotional payoff." },
  { slug: "fantasy", name: "Fantasy", description: "Magic, other worlds, and epic stakes." },
  { slug: "werewolf", name: "Werewolf", description: "Shifters, packs, and moonlit bonds." },
  { slug: "vampire", name: "Vampire", description: "Immortals, hunger, and gothic intrigue." },
  { slug: "billionaire", name: "Billionaire", description: "Power, luxury, and high-stakes desire." },
  { slug: "mafia", name: "Mafia", description: "Crime families, danger, and loyalty." },
  { slug: "ceo", name: "CEO", description: "Boardrooms, ambition, and romance at the top." },
  { slug: "sci-fi", name: "Sci-Fi", description: "Future tech, space, and speculative worlds." },
  { slug: "mystery", name: "Mystery", description: "Clues, secrets, and revelations." },
  { slug: "thriller", name: "Thriller", description: "Suspense, twists, and relentless pace." },
  { slug: "horror", name: "Horror", description: "Dread, the uncanny, and survival." },
  { slug: "action", name: "Action", description: "Fights, chases, and kinetic set pieces." },
  { slug: "adventure", name: "Adventure", description: "Journeys, discovery, and daring escapades." },
  { slug: "comedy", name: "Comedy", description: "Humor, wit, and light-hearted chaos." },
  { slug: "drama", name: "Drama", description: "Character-driven conflict and emotional arcs." },
  {
    slug: "slice-of-life",
    name: "Slice of Life",
    description: "Everyday moments and grounded human stories.",
  },
  { slug: "historical", name: "Historical", description: "Past eras, settings, and costumes." },
  { slug: "lgbtq-plus", name: "LGBTQ+", description: "Queer leads, themes, and relationships." },
  { slug: "mature", name: "Mature", description: "Adult themes and darker tones." },
  { slug: "cultivation", name: "Cultivation", description: "Qi, realms, and progression fantasy." },
  { slug: "litrpg", name: "LitRPG", description: "Systems, stats, and game-like worlds." },
  { slug: "isekai", name: "Isekai", description: "Transported to another world." },
  { slug: "reincarnation", name: "Reincarnation", description: "New lives, old souls, second chances." },
  { slug: "time-travel", name: "Time Travel", description: "Eras colliding and paradox." },
];

const ORDER = STORY_GENRES.map((g) => g.slug);

export const GENRE_SLUG_TO_LABEL: Record<string, string> = Object.fromEntries(
  STORY_GENRES.map((g) => [g.slug, g.name]),
);

export function titleCaseFromKebabSlug(slug: string): string {
  return slug
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

/** Display label for a story genre slug, or title-case fallback for tags / unknown slugs. */
export function labelFromGenreOrTagSlug(slug: string): string {
  const mapped = GENRE_SLUG_TO_LABEL[slug];
  if (mapped) {
    return mapped;
  }
  return titleCaseFromKebabSlug(slug);
}

export type ReaderGenreOption = { label: string; slug: string };

/** Puts known catalog genres first (catalog order), then any extra DB rows by label A–Z. */
export function sortGenresForReaderDisplay(genres: ReaderGenreOption[]): ReaderGenreOption[] {
  return [...genres].sort((a, b) => {
    const ia = ORDER.indexOf(a.slug);
    const ib = ORDER.indexOf(b.slug);
    if (ia === -1 && ib === -1) {
      return a.label.localeCompare(b.label);
    }
    if (ia === -1) {
      return 1;
    }
    if (ib === -1) {
      return -1;
    }
    return ia - ib;
  });
}
