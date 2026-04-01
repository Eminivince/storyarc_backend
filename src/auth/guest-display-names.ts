import { randomInt } from "crypto";

/**
 * Pool for auto-generated guest display names (PascalCase pairs, e.g. InkwellCinder).
 * Kept intentionally off-brand vs "Reader_*" / "User_*".
 */
export const GUEST_NOUNS = [
  "almanac",
  "amber",
  "anchor",
  "aurora",
  "birch",
  "bloom",
  "bramble",
  "briar",
  "canvas",
  "cedar",
  "cipher",
  "citadel",
  "cinder",
  "clover",
  "cobalt",
  "comet",
  "copper",
  "coral",
  "crescent",
  "crow",
  "dahlia",
  "ember",
  "fable",
  "falcon",
  "fern",
  "fiddle",
  "figment",
  "finch",
  "fjord",
  "folio",
  "fossil",
  "garnet",
  "glimmer",
  "granite",
  "grove",
  "harbor",
  "hazel",
  "heron",
  "hoofprint",
  "horizon",
  "indigo",
  "inkwell",
  "iris",
  "ivory",
  "juniper",
  "kestrel",
  "kindling",
  "lark",
  "lichen",
  "linen",
  "lotus",
  "lumen",
  "lyric",
  "mackerel",
  "magnolia",
  "maple",
  "marble",
  "marigold",
  "meadow",
  "meridian",
  "minnow",
  "mistral",
  "moss",
  "nectar",
  "nova",
  "oak",
  "orchid",
  "osprey",
  "parchment",
  "perch",
  "petal",
  "pinnacle",
  "pixel",
  "plume",
  "quartz",
  "quill",
  "raven",
  "reed",
  "ripple",
  "river",
  "sable",
  "saffron",
  "sapphire",
  "sequoia",
  "shard",
  "silhouette",
  "solstice",
  "spar",
  "sparrow",
  "spruce",
  "starling",
  "summit",
  "sundial",
  "swallow",
  "tanager",
  "thistle",
  "tidewind",
  "timber",
  "topaz",
  "torrent",
  "trinket",
  "vellum",
  "verdant",
  "violet",
  "voyage",
  "willow",
  "wisp",
  "yarn",
  "zephyr",
] as const;

function capitalize(word: string): string {
  if (!word) return word;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

function pickDistinctPair(): [string, string] {
  const len = GUEST_NOUNS.length;
  const a = randomInt(0, len - 1);
  let b = randomInt(0, len - 1);
  let guard = 0;
  while (b === a && guard < 64) {
    b = randomInt(0, len - 1);
    guard += 1;
  }
  return [capitalize(GUEST_NOUNS[a]!), capitalize(GUEST_NOUNS[b]!)];
}

/** Two nouns concatenated, e.g. InkwellCinder */
export function makeGuestDisplayNameBase(): string {
  const [x, y] = pickDistinctPair();
  return `${x}${y}`;
}

/** Same as base plus a short hex suffix when the base collides. */
export function makeGuestDisplayNameWithSuffix(suffixHex: string): string {
  const [x, y] = pickDistinctPair();
  return `${x}${y}${suffixHex}`;
}
