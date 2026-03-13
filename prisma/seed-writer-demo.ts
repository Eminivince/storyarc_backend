import { hash } from "bcryptjs";
import {
  AdminBookReleaseMode,
  AdminBookVisibilityState,
  ChapterStatus,
  CreatorApplicationStatus,
  PrismaClient,
  StoryStatus,
  UserRole,
  UserStatus,
} from "@prisma/client";

const prisma = new PrismaClient();
const HASH_ROUNDS = 12;

const writerSeed = {
  bio:
    "A resident StoryArc creator account seeded with complete sample books for studio, reader, and admin testing.",
  displayName: process.env.WRITER_SEED_DISPLAY_NAME?.trim() || "Avery Quinn",
  email: process.env.WRITER_SEED_EMAIL?.trim() || "writer.demo@storyarc.local",
  location: process.env.WRITER_SEED_LOCATION?.trim() || "Lagos, Nigeria",
  password: process.env.WRITER_SEED_PASSWORD?.trim() || "StoryArcWriter123!",
  tagline:
    process.env.WRITER_SEED_TAGLINE?.trim() ||
    "Epic serial fiction across fantasy, sci-fi, mystery, and supernatural romance.",
  website:
    process.env.WRITER_SEED_WEBSITE?.trim() || "https://storyarc.example/avery-quinn",
};

const genreCatalog = {
  fantasy: {
    description: "Epic worlds, magic systems, and ancient destinies.",
    name: "Fantasy",
  },
  mystery: {
    description: "Suspense, shadows, and dangerous secrets.",
    name: "Mystery",
  },
  romance: {
    description: "Emotional relationships and character-driven tension.",
    name: "Romance",
  },
  "sci-fi": {
    description: "Futuristic settings, advanced tech, and cosmic stakes.",
    name: "Sci-Fi",
  },
  supernatural: {
    description: "Dark powers, cursed bloodlines, and eerie transformations.",
    name: "Supernatural",
  },
} as const;

const tagCatalog = {
  "forbidden-love": "Forbidden Love",
  "found-family": "Found Family",
  "magic-academy": "Magic Academy",
  monsters: "Monsters",
  "political-intrigue": "Political Intrigue",
  prophecy: "Prophecy",
  "slow-burn": "Slow Burn",
} as const;

type ChapterSeed = {
  focus: string;
  title: string;
  twist: string;
};

type ArcSeed = {
  chapters: ChapterSeed[];
  title: string;
};

type StorySeed = {
  accentColor: string;
  averageRating: number;
  bannerImageUrl: string;
  cardImageUrl: string;
  coverImageUrl: string;
  genreSlugs: Array<keyof typeof genreCatalog>;
  maturityRating: string;
  premise: string;
  protagonist: string;
  publishedStartDaysAgo: number;
  reviewCount: number;
  setting: string;
  shortSynopsis: string;
  slug: string;
  stakes: string;
  supportingCast: string[];
  synopsis: string;
  tagSlugs: Array<keyof typeof tagCatalog>;
  targetAudience: string;
  title: string;
  totalReads: number;
  volumeTitle: string;
  arcs: ArcSeed[];
};

const stories: StorySeed[] = [
  {
    accentColor: "#f97316",
    averageRating: 4.8,
    bannerImageUrl:
      "https://lh3.googleusercontent.com/aida-public/AB6AXuCxZEtZADGvArJI-bOfr-yF249WWlN3m_X7rHmbgg5M9lIHm2-RgYeH32rkES32oMqBfau_9Ch-F1IlX-euCYurQp21ls7W2Sn_CojoKVrbeq2Ehmj6rP9QGyp_E4_pthM9KvdcYUJhwIw4vEsWieUTEbLZK-qQNc9fIJ5tq9iFRirlJbN8TSrEePrkAsz9gxkVqU7onlZyI9H3tzWgENb9L8iSB5J1hhNha3B6IrrYtL3lJP3k2w2XRc5uU2H4fIu_pBtDhR1K5f0",
    cardImageUrl:
      "https://lh3.googleusercontent.com/aida-public/AB6AXuCxZEtZADGvArJI-bOfr-yF249WWlN3m_X7rHmbgg5M9lIHm2-RgYeH32rkES32oMqBfau_9Ch-F1IlX-euCYurQp21ls7W2Sn_CojoKVrbeq2Ehmj6rP9QGyp_E4_pthM9KvdcYUJhwIw4vEsWieUTEbLZK-qQNc9fIJ5tq9iFRirlJbN8TSrEePrkAsz9gxkVqU7onlZyI9H3tzWgENb9L8iSB5J1hhNha3B6IrrYtL3lJP3k2w2XRc5uU2H4fIu_pBtDhR1K5f0",
    coverImageUrl:
      "https://lh3.googleusercontent.com/aida-public/AB6AXuCxZEtZADGvArJI-bOfr-yF249WWlN3m_X7rHmbgg5M9lIHm2-RgYeH32rkES32oMqBfau_9Ch-F1IlX-euCYurQp21ls7W2Sn_CojoKVrbeq2Ehmj6rP9QGyp_E4_pthM9KvdcYUJhwIw4vEsWieUTEbLZK-qQNc9fIJ5tq9iFRirlJbN8TSrEePrkAsz9gxkVqU7onlZyI9H3tzWgENb9L8iSB5J1hhNha3B6IrrYtL3lJP3k2w2XRc5uU2H4fIu_pBtDhR1K5f0",
    genreSlugs: ["fantasy", "mystery"],
    maturityRating: "16+",
    premise:
      "The imperial capital burns its dead in towers of glass, and every flame conceals a ledger of treason that was never meant to survive the dynasty.",
    protagonist: "Neris Vale",
    publishedStartDaysAgo: 84,
    reviewCount: 612,
    setting: "the cinder-choked capital of Meridian",
    shortSynopsis:
      "A disgraced archivist uncovers a hidden ledger proving the empire's holiest throne was built on state murder.",
    slug: "empire-of-cinders",
    stakes:
      "If Neris fails, the people who trusted her will vanish into the furnaces and the empire will seal itself with a ritual no citizen can outlive.",
    supportingCast: ["Tomas Renn", "Sister Calwen", "Chancellor Marrow"],
    synopsis:
      "When archivist Neris Vale survives an execution order that should have erased her from every public record, she discovers a ledger linking Meridian's sacred throne to generations of engineered disappearances. To expose the truth, she must move through court politics, cathedral vaults, and the furnace districts where the empire smelts both ore and memory.",
    tagSlugs: ["political-intrigue", "prophecy", "found-family"],
    targetAudience: "New Adult",
    title: "Empire of Cinders",
    totalReads: 48750,
    volumeTitle: "Volume 1: The Ash Ledger",
    arcs: [
      {
        title: "Arc I: Smoke on the Palace Steps",
        chapters: [
          {
            focus:
              "a sealed execution order resurfaces in the archive under Neris's own handwriting",
            title: "Ash Writ of the Ninth Bell",
            twist:
              "the signature belongs to a future date, proving someone inside the throne room is rewriting state history in advance",
          },
          {
            focus:
              "Neris follows the paper trail into the furnace district and meets workers who know the names of the disappeared",
            title: "The Furnace Census",
            twist:
              "the district keeps a private list of the dead, and one of the names is Neris's brother",
          },
          {
            focus:
              "a cathedral envoy offers help in exchange for the ledger pages Neris has hidden in her coat lining",
            title: "Cathedral of Borrowed Fire",
            twist:
              "the envoy already knows where every missing page is buried because she planted two of them herself",
          },
          {
            focus:
              "the city gathers for a public oath ceremony while Tomas prepares a diversion at the palace granary",
            title: "Granary for Traitors",
            twist:
              "the granary fire reveals a second vault beneath the throne, built to hold witnesses rather than grain",
          },
        ],
      },
      {
        title: "Arc II: The Hidden Ledger",
        chapters: [
          {
            focus:
              "Neris breaks into the lower vault and finds living prisoners who have been declared dead for years",
            title: "Below the Glass Throne",
            twist:
              "one prisoner confesses that the throne itself only works because a prophet is kept alive beneath it",
          },
          {
            focus:
              "Sister Calwen prepares to leak the ledger during a state procession that celebrates imperial mercy",
            title: "Mercy in Procession",
            twist:
              "the processional hymns double as a command sequence for the city's execution wards",
          },
          {
            focus:
              "Neris must decide whether to publish the truth immediately or use it to bargain for the prisoners' release",
            title: "When Cinders Learn to Speak",
            twist:
              "the final ledger page identifies Neris as the legal heir to the office that can depose the throne at dawn",
          },
        ],
      },
    ],
  },
  {
    accentColor: "#22c55e",
    averageRating: 4.7,
    bannerImageUrl:
      "https://lh3.googleusercontent.com/aida-public/AB6AXuCCYW0y-x4ynHbueBL_GVj0rmx8YZb9bS3-OhHF5PK8lJ1fL8LD70Df9FdG0iHv213Y3bU03qhha_6G7zV4QhEgZtTDJlYW_uqLaDdI2brsH13sAMk0rbvMoqNSmVUQ3KcZNydVIp5aIwiZgqjsQggwb7aIekblpAOwfhNbs3tdWzgyASewwW_9vPUgs0Nagmka0hyNN3Gb-mFcRM8WDo8x2NoIJ2BLZ8T7N0EBKn1yDQskyqL4fv24_6GB-fOJSgjo4EHtOZmUlvw",
    cardImageUrl:
      "https://lh3.googleusercontent.com/aida-public/AB6AXuCCYW0y-x4ynHbueBL_GVj0rmx8YZb9bS3-OhHF5PK8lJ1fL8LD70Df9FdG0iHv213Y3bU03qhha_6G7zV4QhEgZtTDJlYW_uqLaDdI2brsH13sAMk0rbvMoqNSmVUQ3KcZNydVIp5aIwiZgqjsQggwb7aIekblpAOwfhNbs3tdWzgyASewwW_9vPUgs0Nagmka0hyNN3Gb-mFcRM8WDo8x2NoIJ2BLZ8T7N0EBKn1yDQskyqL4fv24_6GB-fOJSgjo4EHtOZmUlvw",
    coverImageUrl:
      "https://lh3.googleusercontent.com/aida-public/AB6AXuCCYW0y-x4ynHbueBL_GVj0rmx8YZb9bS3-OhHF5PK8lJ1fL8LD70Df9FdG0iHv213Y3bU03qhha_6G7zV4QhEgZtTDJlYW_uqLaDdI2brsH13sAMk0rbvMoqNSmVUQ3KcZNydVIp5aIwiZgqjsQggwb7aIekblpAOwfhNbs3tdWzgyASewwW_9vPUgs0Nagmka0hyNN3Gb-mFcRM8WDo8x2NoIJ2BLZ8T7N0EBKn1yDQskyqL4fv24_6GB-fOJSgjo4EHtOZmUlvw",
    genreSlugs: ["sci-fi", "mystery"],
    maturityRating: "13+",
    premise:
      "The station-city of Vanta Nine survives on reactor songs, but the songs are beginning to skip in the exact places where entire labor crews vanished from payroll.",
    protagonist: "Lina Oris",
    publishedStartDaysAgo: 70,
    reviewCount: 441,
    setting: "the orbital shipyards of Vanta Nine",
    shortSynopsis:
      "An engineer chasing a reactor anomaly uncovers a conspiracy hiding missing crews inside the station's maintenance code.",
    slug: "afterlight-circuit",
    stakes:
      "If Lina cannot decode the sabotage before the next heat cycle, the station will vent half a million residents into the eclipse corridor and bury the evidence with them.",
    supportingCast: ["Jae Mercer", "Doctor Soriah", "Director Kel"],
    synopsis:
      "Chief engineer Lina Oris has spent a decade patching reactor failures before they become public disasters. When a fault map starts pointing at erased employee records instead of broken hardware, she discovers that Vanta Nine's ruling board has been feeding human lives into a predictive machine designed to keep the station profitable through any casualty count.",
    tagSlugs: ["found-family", "political-intrigue", "prophecy"],
    targetAudience: "Young Adult",
    title: "Afterlight Circuit",
    totalReads: 36510,
    volumeTitle: "Volume 1: Echoes in the Grid",
    arcs: [
      {
        title: "Arc I: Fault Map",
        chapters: [
          {
            focus:
              "a maintenance sweep reveals a heat bloom inside a corridor that no longer exists on public maps",
            title: "Static Under Hull Seven",
            twist:
              "the deleted corridor still draws power because someone turned it into a hidden server spine",
          },
          {
            focus:
              "Lina and Jae trail the phantom power drain into the freight elevators used by vanished contractors",
            title: "Freight Lift to Nowhere",
            twist:
              "every vanished worker clocked out under Lina's authorization code even though she never saw the logs",
          },
          {
            focus:
              "Doctor Soriah patches a damaged memory shard recovered from a coolant reservoir",
            title: "Mnemonic Spill",
            twist:
              "the shard contains audio of the reactor choir reciting the names of missing workers in sequence",
          },
          {
            focus:
              "the board summons Lina to explain the outage while the station prepares for a ceremonial eclipse",
            title: "Boardroom in Eclipse",
            twist:
              "Director Kel offers Lina a promotion if she helps bury the fault map before dawn",
          },
        ],
      },
      {
        title: "Arc II: The Hidden Choir",
        chapters: [
          {
            focus:
              "Lina descends into the sealed acoustic chamber where the reactor songs are physically generated",
            title: "Choir Beneath the Core",
            twist:
              "the reactor is not predicting failures; it is steering workers into them to maintain output targets",
          },
          {
            focus:
              "Jae broadcasts the first proof packet to the civilian mesh while station security starts a rolling blackout",
            title: "Blackout Protocol",
            twist:
              "the blackout is a cover for launching an evacuation pod filled with the board's private ledgers",
          },
          {
            focus:
              "Lina must choose between stopping the evacuation and stabilizing the core before the eclipse ends",
            title: "Signal After Midnight",
            twist:
              "the final override reveals Lina's mother designed the reactor and left one impossible shutoff key in Lina's childhood lullaby",
          },
        ],
      },
    ],
  },
  {
    accentColor: "#f59e0b",
    averageRating: 4.9,
    bannerImageUrl:
      "https://lh3.googleusercontent.com/aida-public/AB6AXuDnalVe9uggXR9tQEZ4roIax46fhC0Dv5DTA0TjhOAbZpfk8ncXGur7CFdmakRJsKaG5086GBl_7tXUyII6ImkzbxTP8UlGqdi98U0EvInIHv48fIC1tdEbCYVyCAp5GI-EPXkdIE16f2YOHbSg12pNcsenD_PdonRCEcWzZc3SvpjaGCCdhi8TuBZidM8AK2stmhFjkc2y_IusZTaGhmFQIZBr7hF3scRQ1l5KNnj-4cK8VwRxxLQqmzOZznFyuPWqIoslGVMc6EI",
    cardImageUrl:
      "https://lh3.googleusercontent.com/aida-public/AB6AXuCZlq_xmsMUKyy23pPY0MLEhA9DBAibewCgSaVJ6PFkQJUQwMpU7zY-KIk14WS7_ZbZAiJCXgF-bVs9TN_CVFk5Lic8yaFnDsW25kLi4bB2MIW25Cm0UCO7D1O7dYbXhqsZlugDNn5EpMKbSoZg86JqAJH2Z_ar6BcZPBzzzugateEKXrQ87egp0xcO-uzqs66tsQ03HuN18ZGDmIc569hJf7o6-t5zsmP8h3fpojuKBrpy-P1yjE68MnXSQNq1cB8HS-2MvLtfhUE",
    coverImageUrl:
      "https://lh3.googleusercontent.com/aida-public/AB6AXuCZlq_xmsMUKyy23pPY0MLEhA9DBAibewCgSaVJ6PFkQJUQwMpU7zY-KIk14WS7_ZbZAiJCXgF-bVs9TN_CVFk5Lic8yaFnDsW25kLi4bB2MIW25Cm0UCO7D1O7dYbXhqsZlugDNn5EpMKbSoZg86JqAJH2Z_ar6BcZPBzzzugateEKXrQ87egp0xcO-uzqs66tsQ03HuN18ZGDmIc569hJf7o6-t5zsmP8h3fpojuKBrpy-P1yjE68MnXSQNq1cB8HS-2MvLtfhUE",
    genreSlugs: ["supernatural", "romance", "fantasy"],
    maturityRating: "18+",
    premise:
      "Every tide season on Saint Aris carries voices out of the sea caves, and this year one of them is speaking with the drowned prince's authority.",
    protagonist: "Maelin Roe",
    publishedStartDaysAgo: 63,
    reviewCount: 703,
    setting: "the salt-lit harbor city of Saint Aris",
    shortSynopsis:
      "A smuggler bound to a sea-spirit falls for the exorcist sent to cage her, just as the harbor begins raising its dead.",
    slug: "saltblood-vow",
    stakes:
      "If Maelin and the exorcist fail, the harbor's covenant will wake every drowned oath in the bay and drag the living city into the undertow with it.",
    supportingCast: ["Father Lucan", "Captain Seris", "the Drowned Prince"],
    synopsis:
      "Maelin Roe has survived Saint Aris by ferrying contraband through tidal caves haunted by a sea-spirit that marks her blood. When the church dispatches exorcist Lucan Vale to investigate the harbor's rising dead, their alliance turns intimate and dangerous. The deeper they go, the clearer it becomes that the sea is not asking for worship. It is collecting on a promise someone made generations ago.",
    tagSlugs: ["forbidden-love", "slow-burn", "monsters"],
    targetAudience: "Adult",
    title: "Saltblood Vow",
    totalReads: 59280,
    volumeTitle: "Volume 1: Harbor of Broken Oaths",
    arcs: [
      {
        title: "Arc I: The Tide Remembers",
        chapters: [
          {
            focus:
              "Maelin discovers a coffin washed into the tide caves with no body inside and royal seals still intact",
            title: "Coffin in the Tidal Mouth",
            twist:
              "the empty coffin bears Maelin's family crest on the interior where only the dead were meant to see it",
          },
          {
            focus:
              "Lucan arrives to bless the harbor, but his rites fail the moment Maelin steps into the chapel threshold",
            title: "The Exorcist at Low Tide",
            twist:
              "Lucan recognizes the spirit mark in Maelin's blood because he carries the matching seal in his prayer book",
          },
          {
            focus:
              "the first drowned citizens rise during a storm market and begin walking toward the old lighthouse",
            title: "Storm Market Resurrection",
            twist:
              "every drowned body mouths the same vow, and the vow names Lucan as its witness",
          },
          {
            focus:
              "Maelin leads Lucan into the smugglers' tunnels where the harbor's oldest bargains were carved into wet stone",
            title: "Tunnel of Brine and Bone",
            twist:
              "the carvings reveal Maelin was promised to the sea before she was born",
          },
        ],
      },
      {
        title: "Arc II: Covenant Below the Breakwater",
        chapters: [
          {
            focus:
              "Captain Seris bargains for safe passage to the breakwater mausoleum while the city council prepares a purge",
            title: "Breakwater Funeral",
            twist:
              "the council wants the purge because they are descendants of the priests who forged the original false covenant",
          },
          {
            focus:
              "Lucan and Maelin finally confess the bond between them while the sea caves begin flooding inland streets",
            title: "When the Harbor Chose Us",
            twist:
              "their bond stabilizes the spirit mark long enough to reveal the true grave of the drowned prince",
          },
          {
            focus:
              "the harbor demands a living witness to rewrite the covenant before sunrise shatters the tide gate",
            title: "Vow at First Floodlight",
            twist:
              "Maelin learns her mother never died at sea at all and has been serving as the covenant's hidden witness under the city",
          },
        ],
      },
    ],
  },
  {
    accentColor: "#0f172a",
    averageRating: 4.6,
    bannerImageUrl:
      "https://lh3.googleusercontent.com/aida-public/AB6AXuBDkui4Hew1g0I8vtakp7rEn_YfQSfHlJRlVdwtuVxT09FRKAkg3Zwl-GzXCim5QeSdcqc_Cka9C9wQzEcQnq-Ev-zs00QR3Qi3sY-8ShatUik9dqWXTSOOywZlkmdnJw8E_TjlJVZMsE10ehGw9xmBeb0bsR92lXnSo7KlQLCfOqyQnXgWecwG5zFNddvbMqnpK5Ly5hsx55qN5AEbm9Z5IR2K2tKjPoAVMp8RRe7_vCqkEhPYJrMP1PWv_K6rHyKxw8XLKH2sQUc",
    cardImageUrl:
      "https://lh3.googleusercontent.com/aida-public/AB6AXuBDkui4Hew1g0I8vtakp7rEn_YfQSfHlJRlVdwtuVxT09FRKAkg3Zwl-GzXCim5QeSdcqc_Cka9C9wQzEcQnq-Ev-zs00QR3Qi3sY-8ShatUik9dqWXTSOOywZlkmdnJw8E_TjlJVZMsE10ehGw9xmBeb0bsR92lXnSo7KlQLCfOqyQnXgWecwG5zFNddvbMqnpK5Ly5hsx55qN5AEbm9Z5IR2K2tKjPoAVMp8RRe7_vCqkEhPYJrMP1PWv_K6rHyKxw8XLKH2sQUc",
    coverImageUrl:
      "https://lh3.googleusercontent.com/aida-public/AB6AXuBDkui4Hew1g0I8vtakp7rEn_YfQSfHlJRlVdwtuVxT09FRKAkg3Zwl-GzXCim5QeSdcqc_Cka9C9wQzEcQnq-Ev-zs00QR3Qi3sY-8ShatUik9dqWXTSOOywZlkmdnJw8E_TjlJVZMsE10ehGw9xmBeb0bsR92lXnSo7KlQLCfOqyQnXgWecwG5zFNddvbMqnpK5Ly5hsx55qN5AEbm9Z5IR2K2tKjPoAVMp8RRe7_vCqkEhPYJrMP1PWv_K6rHyKxw8XLKH2sQUc",
    genreSlugs: ["mystery", "fantasy"],
    maturityRating: "16+",
    premise:
      "The city below the library has no sunlight and no legal history, only paper kingdoms stacked under the streets and ruled by archivists who erase wars by hand.",
    protagonist: "Ivo March",
    publishedStartDaysAgo: 56,
    reviewCount: 388,
    setting: "the buried catalog tunnels beneath the city of Rheel",
    shortSynopsis:
      "A debt collector turned catalog runner discovers an underground paper kingdom where history is edited before it reaches the surface.",
    slug: "paper-kingdom-below",
    stakes:
      "If Ivo cannot get the lost index back to the surface, the rulers below will erase his sister's trial from history and condemn her without any record that she ever existed.",
    supportingCast: ["Mira Pell", "Archivist Beren", "the Paper Regent"],
    synopsis:
      "Ivo March only intended to collect a debt from a printer who disappeared into Rheel's abandoned stacks. Instead he falls through a catalog shaft into a hidden kingdom run by archivists who control what the surface world is allowed to remember. To save his sister from a conviction built on edited evidence, Ivo must steal the index that links every erased trial, treaty, and inheritance to the people who lost them.",
    tagSlugs: ["political-intrigue", "found-family", "magic-academy"],
    targetAudience: "Young Adult",
    title: "The Paper Kingdom Below",
    totalReads: 27490,
    volumeTitle: "Volume 1: Index of the Buried Crown",
    arcs: [
      {
        title: "Arc I: Catalog Fall",
        chapters: [
          {
            focus:
              "Ivo follows a debtor through a collapsing print room and lands in a city made of suspended shelves",
            title: "The Shelf That Opened Underfoot",
            twist:
              "the debtor has been dead for three years on the surface, but the kingdom below still lists him as a licensed witness",
          },
          {
            focus:
              "Mira agrees to guide Ivo in exchange for help stealing a court index from the regent's clerks",
            title: "Ink Tax on the Lower Streets",
            twist:
              "the index shows Ivo's sister has already been sentenced in a trial that has not happened yet",
          },
          {
            focus:
              "Ivo learns the buried kingdom edits surface law by intercepting archives before sunrise couriers arrive",
            title: "Before the Dawn Couriers",
            twist:
              "the courier network answers to Archivist Beren, who once trained Ivo's mother",
          },
          {
            focus:
              "a raid on the regent's scriptorium uncovers a chamber where verdicts are copied into living vellum",
            title: "Scriptorium of Borrowed Verdicts",
            twist:
              "one living page begins writing Ivo's future testimony before he speaks it",
          },
        ],
      },
      {
        title: "Arc II: The Buried Crown",
        chapters: [
          {
            focus:
              "Mira and Ivo infiltrate the coronation archive where the regent stores erased bloodlines",
            title: "Coronation in the Dust Vault",
            twist:
              "Ivo's surname appears on the same register as the regent's heirs",
          },
          {
            focus:
              "the lower city fractures when citizens learn their tax records were forged to fund a surface coup",
            title: "When the Margins Revolted",
            twist:
              "Archivist Beren admits he forged the records to protect Ivo as a child",
          },
          {
            focus:
              "Ivo must decide whether to publish the full index and collapse both governments or save only his sister",
            title: "Index of the Unforgiven",
            twist:
              "the final index page declares the Paper Regent is merely the keeper, and the true crown belongs to whoever returns history to the people unchanged",
          },
        ],
      },
    ],
  },
];

function daysAgo(days: number) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function countWords(text: string) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function estimateReadingMinutes(wordCount: number) {
  return Math.max(7, Math.ceil(wordCount / 220));
}

function buildChapterParagraphs(
  story: StorySeed,
  chapter: ChapterSeed,
  chapterNumber: number,
) {
  const [ally, secondAlly, rival] = story.supportingCast;
  return [
    `Chapter ${chapterNumber} of ${story.title} opens in ${story.setting}, where ${story.protagonist} has learned that survival depends less on courage than on noticing the tiny procedural lies everyone else has agreed to treat as law. ${chapter.focus.charAt(0).toUpperCase()}${chapter.focus.slice(1)} becomes impossible to dismiss the moment the room changes temperature around it, and the ordinary citizens nearest the disturbance react with the exhausted obedience of people who have seen danger before and still cannot afford to run.`,
    `${story.protagonist} does not move like a chosen hero. They move like someone trained by hunger, debt, and memory to count doors, exits, witnesses, and the number of lies it will take to survive a single conversation. That instinct makes every exchange in this chapter feel edged: every compliment could be surveillance, every prayer could be a command, and every official document could carry the weight of a death sentence disguised as clerical routine. In ${story.setting}, paperwork is never neutral, and silence is usually the most expensive currency in the room.`,
    `${ally} steps into the scene with their own private agenda, forcing ${story.protagonist} to choose whether trust is an investment or a fresh category of risk. Their dialogue keeps circling the same pressure point: ${story.premise} Neither of them says the entire truth at first, because in serial fiction the best alliances arrive half-built and under stress, but the emotional architecture is clear. They need each other, they resent needing each other, and the chapter gains momentum from every sentence where obligation sounds dangerously close to loyalty.`,
    `The worldbuilding in this section slows down just enough to let the environment breathe. You can feel the grit on handrails, smell machine oil or wet salt or archive dust depending on the corridor, and hear the civic machinery behind the plot grinding in the background. That texture matters because the system oppressing the cast is never abstract; it lives in schedules, rituals, uniforms, ledgers, bells, fuel lines, and gatekeeping language. ${story.protagonist} understands that systems survive by training ordinary people to carry out extraordinary cruelty one small justified step at a time.`,
    `${secondAlly ?? ally} introduces a piece of evidence that seems practical on its face: a ledger fragment, a corrupted map, a witness account, a forbidden seal, or a memory no official archive was supposed to preserve. The evidence does not simply confirm a suspicion. It rearranges the moral geometry of the chapter. Once it appears, ${story.protagonist} can no longer pretend the danger is local or personal. ${story.stakes} The pacing tightens because the chapter stops being about discovery and starts being about consequence.`,
    `Conflict escalates when ${rival} pushes back with the confidence of someone protected by the institution itself. They do not need to win every argument; they only need to delay the right truth until the machinery of power can grind forward on schedule. That makes the confrontation sharper than a simple clash of personalities. ${rival} represents a worldview in which harm is acceptable so long as it remains procedural, documented, and sufficiently distant from the people signing the orders. ${story.protagonist} recognizes that logic because it has already taken too much from them.`,
    `Midway through the chapter, the emotional core surfaces. ${story.protagonist} is forced to admit, if only inwardly, what they most fear losing if this fight continues. It might be family, anonymity, a chance at tenderness, or the illusion that skill alone can protect the people they love. This interior turn gives the chapter weight beyond plot utility. Readers stay not just for the twist, but because the character's private cost is rendered clearly enough that every next decision feels earned rather than convenient.`,
    `The action movement that follows is grounded in the story's specific logic. Doors are breached with forged keys, wards are crossed with blasphemous timing, reactor shafts are climbed while alarms fail in sequence, or drowned dead march according to vows that still bind the living. The scene works because it balances spectacle with process. We know what must be done, who is improvising, who is panicking, and what tiny overlooked detail could bring everything down. By the time the momentum peaks, the chapter has fully committed to its promise of serialized escalation.`,
    `${chapter.twist.charAt(0).toUpperCase()}${chapter.twist.slice(1)} The reveal lands with force because it changes both plot direction and character strategy at once. Instead of merely adding surprise, it reinterprets what came before: a stray line of dialogue becomes a clue, a ceremonial object becomes evidence, a family story becomes policy, and a romantic hesitation becomes proof that two people were standing inside the same trap from opposite sides. The best serial hooks do this. They do not just shout. They reframe.`,
    `The closing paragraphs refuse easy relief. ${story.protagonist} leaves the chapter with more information than safety, more allies than certainty, and a sharper understanding of how large the battlefield really is. The institution pressing against them has not weakened; it has merely been forced to show one more hidden mechanism. That distinction matters, because readers should feel the victory in the chapter while still understanding that the wider war remains unresolved.`,
    `By the final line, the chapter turns its gaze forward. A door opens where no architecture should allow one. A public ceremony is set to begin under false blessings. A private message arrives from someone presumed dead. Or a city-scale machine begins to hum in the exact frequency of a prophecy everyone dismissed as decorative folklore. Whatever form it takes, the ending promises that the next installment will not simply continue the current problem. It will deepen it, complicate it, and demand more from everyone already trapped inside ${story.title}.`,
  ];
}

async function ensureBookPlatformPolicy() {
  const existingPolicy = await prisma.bookPlatformPolicy.findUnique({
    where: {
      key: "default",
    },
  });

  if (existingPolicy) {
    await prisma.bookPlatformPolicy.update({
      where: {
        id: existingPolicy.id,
      },
      data: {
        defaultCoinCap: 50,
        defaultPremiumWindowHours: -1,
        defaultReleaseMode: AdminBookReleaseMode.PREMIUM_WINDOW,
      },
    });
    return;
  }

  await prisma.bookPlatformPolicy.create({
    data: {
      defaultCoinCap: 50,
      defaultPremiumWindowHours: -1,
      defaultReleaseMode: AdminBookReleaseMode.PREMIUM_WINDOW,
      key: "default",
    },
  });
}

async function ensureGenresAndTags() {
  const genreSlugs = new Set(stories.flatMap((story) => story.genreSlugs));
  const tagSlugs = new Set(stories.flatMap((story) => story.tagSlugs));

  for (const genreSlug of genreSlugs) {
    const genre = genreCatalog[genreSlug];
    const existingGenre = await prisma.genre.findUnique({
      where: {
        slug: genreSlug,
      },
    });

    if (existingGenre) {
      await prisma.genre.update({
        where: {
          id: existingGenre.id,
        },
        data: {
          description: genre.description,
          name: genre.name,
        },
      });
      continue;
    }

    await prisma.genre.create({
      data: {
        description: genre.description,
        name: genre.name,
        slug: genreSlug,
      },
    });
  }

  for (const tagSlug of tagSlugs) {
    const existingTag = await prisma.tag.findUnique({
      where: {
        slug: tagSlug,
      },
    });

    if (existingTag) {
      await prisma.tag.update({
        where: {
          id: existingTag.id,
        },
        data: {
          name: tagCatalog[tagSlug],
        },
      });
      continue;
    }

    await prisma.tag.create({
      data: {
        name: tagCatalog[tagSlug],
        slug: tagSlug,
      },
    });
  }
}

async function upsertWriterAccount() {
  const passwordHash = await hash(writerSeed.password, HASH_ROUNDS);
  const now = new Date();

  const existingUser = await prisma.user.findUnique({
    where: {
      email: writerSeed.email,
    },
  });

  const user = existingUser
    ? await prisma.user.update({
        where: {
          id: existingUser.id,
        },
        data: {
          emailVerifiedAt: now,
          role: UserRole.CREATOR,
          status: UserStatus.ACTIVE,
        },
      })
    : await prisma.user.create({
        data: {
          email: writerSeed.email,
          emailVerifiedAt: now,
          role: UserRole.CREATOR,
          status: UserStatus.ACTIVE,
        },
      });

  const existingProfile = await prisma.profile.findUnique({
    where: {
      userId: user.id,
    },
  });

  if (existingProfile) {
    await prisma.profile.update({
      where: {
        id: existingProfile.id,
      },
      data: {
        bio: writerSeed.bio,
        displayName: writerSeed.displayName,
        location: writerSeed.location,
        onboardingCompletedAt: now,
        tagline: writerSeed.tagline,
        website: writerSeed.website,
      },
    });
  } else {
    await prisma.profile.create({
      data: {
        bio: writerSeed.bio,
        displayName: writerSeed.displayName,
        location: writerSeed.location,
        onboardingCompletedAt: now,
        tagline: writerSeed.tagline,
        userId: user.id,
        website: writerSeed.website,
      },
    });
  }

  const existingCredential = await prisma.credential.findUnique({
    where: {
      userId: user.id,
    },
  });

  if (existingCredential) {
    await prisma.credential.update({
      where: {
        id: existingCredential.id,
      },
      data: {
        passwordHash,
      },
    });
  } else {
    await prisma.credential.create({
      data: {
        passwordHash,
        userId: user.id,
      },
    });
  }

  const existingApplication = await prisma.creatorApplication.findUnique({
    where: {
      userId: user.id,
    },
  });

  if (existingApplication) {
    await prisma.creatorApplication.update({
      where: {
        id: existingApplication.id,
      },
      data: {
        email: writerSeed.email,
        experience: "Published serialized fiction and long-form story design.",
        fullName: writerSeed.displayName,
        motivation:
          "Seeded creator account for testing studio workflows, public reading flows, and admin review surfaces.",
        primaryGenre: "Fantasy",
        reviewNotes: "Approved automatically by demo seed script.",
        reviewedAt: now,
        status: CreatorApplicationStatus.APPROVED,
        submittedAt: now,
      },
    });
  } else {
    await prisma.creatorApplication.create({
      data: {
        email: writerSeed.email,
        experience: "Published serialized fiction and long-form story design.",
        fullName: writerSeed.displayName,
        motivation:
          "Seeded creator account for testing studio workflows, public reading flows, and admin review surfaces.",
        primaryGenre: "Fantasy",
        reviewNotes: "Approved automatically by demo seed script.",
        reviewedAt: now,
        status: CreatorApplicationStatus.APPROVED,
        submittedAt: now,
        userId: user.id,
      },
    });
  }

  return user;
}

async function upsertStory(userId: string, story: StorySeed) {
  const chapterBlueprints = story.arcs.flatMap((arc, arcIndex) =>
    arc.chapters.map((chapter, chapterIndex) => ({
      arcIndex,
      chapter,
      chapterNumber:
        story.arcs
          .slice(0, arcIndex)
          .reduce((count, currentArc) => count + currentArc.chapters.length, 0) +
        chapterIndex +
        1,
      publishedAt: daysAgo(
        story.publishedStartDaysAgo -
          (story.arcs
            .slice(0, arcIndex)
            .reduce((count, currentArc) => count + currentArc.chapters.length, 0) +
            chapterIndex) *
            5,
      ),
    })),
  );

  const latestChapterAt = chapterBlueprints.reduce((current, chapter) => {
    return chapter.publishedAt.getTime() > current.getTime()
      ? chapter.publishedAt
      : current;
  }, chapterBlueprints[0].publishedAt);

  const existingStory = await prisma.story.findUnique({
    where: {
      slug: story.slug,
    },
  });

  const storyRecord = existingStory
    ? await prisma.story.update({
        where: {
          id: existingStory.id,
        },
        data: {
          authorId: userId,
          authorName: writerSeed.displayName,
          averageRating: story.averageRating,
          featured: false,
          genreSlugs: story.genreSlugs,
          isLive: true,
          latestChapterAt,
          liveAt: chapterBlueprints[0].publishedAt,
          maturityRating: story.maturityRating,
          publishedAt: chapterBlueprints[0].publishedAt,
          reviewCount: story.reviewCount,
          shortSynopsis: story.shortSynopsis,
          status: StoryStatus.PUBLISHED,
          synopsis: story.synopsis,
          tagSlugs: story.tagSlugs,
          targetAudience: story.targetAudience,
          title: story.title,
          totalReads: story.totalReads,
        },
      })
    : await prisma.story.create({
        data: {
          authorId: userId,
          authorName: writerSeed.displayName,
          averageRating: story.averageRating,
          featured: false,
          genreSlugs: story.genreSlugs,
          isLive: true,
          latestChapterAt,
          liveAt: chapterBlueprints[0].publishedAt,
          maturityRating: story.maturityRating,
          publishedAt: chapterBlueprints[0].publishedAt,
          reviewCount: story.reviewCount,
          shortSynopsis: story.shortSynopsis,
          slug: story.slug,
          status: StoryStatus.PUBLISHED,
          synopsis: story.synopsis,
          tagSlugs: story.tagSlugs,
          targetAudience: story.targetAudience,
          title: story.title,
          totalReads: story.totalReads,
        },
      });

  const existingAsset = await prisma.storyAsset.findUnique({
    where: {
      storyId: storyRecord.id,
    },
  });

  if (existingAsset) {
    await prisma.storyAsset.update({
      where: {
        id: existingAsset.id,
      },
      data: {
        accentColor: story.accentColor,
        bannerImageUrl: story.bannerImageUrl,
        cardImageUrl: story.cardImageUrl,
        coverImageUrl: story.coverImageUrl,
      },
    });
  } else {
    await prisma.storyAsset.create({
      data: {
        accentColor: story.accentColor,
        bannerImageUrl: story.bannerImageUrl,
        cardImageUrl: story.cardImageUrl,
        coverImageUrl: story.coverImageUrl,
        storyId: storyRecord.id,
      },
    });
  }

  const existingVolume = await prisma.storyVolume.findUnique({
    where: {
      storyId_number: {
        number: 1,
        storyId: storyRecord.id,
      },
    },
  });

  const volume = existingVolume
    ? await prisma.storyVolume.update({
        where: {
          id: existingVolume.id,
        },
        data: {
          number: 1,
          sortOrder: 0,
          statusLabel: "Live",
          title: story.volumeTitle,
        },
      })
    : await prisma.storyVolume.create({
        data: {
          number: 1,
          sortOrder: 0,
          statusLabel: "Live",
          storyId: storyRecord.id,
          title: story.volumeTitle,
        },
      });

  const arcRecords = new Map<number, string>();

  for (const [arcIndex, arc] of story.arcs.entries()) {
    const existingArc = await prisma.storyArc.findFirst({
      where: {
        storyId: storyRecord.id,
        title: arc.title,
        volumeId: volume.id,
      },
    });

    const arcRecord = existingArc
      ? await prisma.storyArc.update({
          where: {
            id: existingArc.id,
          },
          data: {
            sortOrder: arcIndex,
            statusLabel: "Live",
            title: arc.title,
          },
        })
      : await prisma.storyArc.create({
          data: {
            sortOrder: arcIndex,
            statusLabel: "Live",
            storyId: storyRecord.id,
            title: arc.title,
            volumeId: volume.id,
          },
        });

    arcRecords.set(arcIndex, arcRecord.id);
  }

  for (const chapterBlueprint of chapterBlueprints) {
    const bodyParagraphs = buildChapterParagraphs(
      story,
      chapterBlueprint.chapter,
      chapterBlueprint.chapterNumber,
    );
    const bodyDraft = bodyParagraphs.join("\n\n");
    const wordCount = countWords(bodyDraft);
    const readingMinutes = estimateReadingMinutes(wordCount);
    const excerpt = bodyParagraphs[0];
    const chapterSlug = slugify(chapterBlueprint.chapter.title);
    const arcId = arcRecords.get(chapterBlueprint.arcIndex) ?? null;

    const existingChapter = await prisma.chapter.findFirst({
      where: {
        chapterNumber: chapterBlueprint.chapterNumber,
        storyId: storyRecord.id,
      },
      include: {
        publishedChapter: true,
      },
    });

    const chapterRecord = existingChapter
      ? await prisma.chapter.update({
          where: {
            id: existingChapter.id,
          },
          data: {
            arcId,
            authorNote: `Author note: ${story.title} continues to widen its world and sharpen the emotional stakes in chapter ${chapterBlueprint.chapterNumber}.`,
            bodyDraft,
            chapterNumber: chapterBlueprint.chapterNumber,
            coinUnlockPrice: 0,
            contentWarnings: [],
            excerpt,
            lastPublishedAt: chapterBlueprint.publishedAt,
            premiumEnabled: false,
            readingMinutes,
            scheduledFor: null,
            slug: chapterSlug,
            status: ChapterStatus.PUBLISHED,
            title: chapterBlueprint.chapter.title,
            volumeId: volume.id,
            wordCount,
          },
          include: {
            publishedChapter: true,
          },
        })
      : await prisma.chapter.create({
          data: {
            arcId,
            authorNote: `Author note: ${story.title} continues to widen its world and sharpen the emotional stakes in chapter ${chapterBlueprint.chapterNumber}.`,
            bodyDraft,
            chapterNumber: chapterBlueprint.chapterNumber,
            coinUnlockPrice: 0,
            contentWarnings: [],
            excerpt,
            lastPublishedAt: chapterBlueprint.publishedAt,
            premiumEnabled: false,
            readingMinutes,
            scheduledFor: null,
            slug: chapterSlug,
            status: ChapterStatus.PUBLISHED,
            storyId: storyRecord.id,
            title: chapterBlueprint.chapter.title,
            volumeId: volume.id,
            wordCount,
          },
          include: {
            publishedChapter: true,
          },
        });

    if (chapterRecord.publishedChapter) {
      await prisma.publishedChapter.update({
        where: {
          id: chapterRecord.publishedChapter.id,
        },
        data: {
          bodyParagraphs,
          chapterNumber: chapterBlueprint.chapterNumber,
          coinUnlockPrice: 0,
          premium: false,
          publishedAt: chapterBlueprint.publishedAt,
          slug: chapterSlug,
          title: chapterBlueprint.chapter.title,
        },
      });
    } else {
      await prisma.publishedChapter.create({
        data: {
          bodyParagraphs,
          chapterId: chapterRecord.id,
          chapterNumber: chapterBlueprint.chapterNumber,
          coinUnlockPrice: 0,
          premium: false,
          publishedAt: chapterBlueprint.publishedAt,
          slug: chapterSlug,
          storyId: storyRecord.id,
          title: chapterBlueprint.chapter.title,
        },
      });
    }
  }

  const existingAdminControl = await prisma.storyAdminControl.findUnique({
    where: {
      storyId: storyRecord.id,
    },
  });

  if (existingAdminControl) {
    await prisma.storyAdminControl.update({
      where: {
        id: existingAdminControl.id,
      },
      data: {
        defaultPremiumWindowHours: -1,
        globalCoinCap: 50,
        releaseMode: AdminBookReleaseMode.PREMIUM_WINDOW,
        reviewNotes: "Seeded as a live demo title for creator testing.",
        reviewedAt: latestChapterAt,
        visibilityState: AdminBookVisibilityState.LIVE,
      },
    });
  } else {
    await prisma.storyAdminControl.create({
      data: {
        defaultPremiumWindowHours: -1,
        globalCoinCap: 50,
        releaseMode: AdminBookReleaseMode.PREMIUM_WINDOW,
        reviewNotes: "Seeded as a live demo title for creator testing.",
        reviewedAt: latestChapterAt,
        storyId: storyRecord.id,
        visibilityState: AdminBookVisibilityState.LIVE,
      },
    });
  }

  return {
    chapterCount: chapterBlueprints.length,
    slug: story.slug,
    title: story.title,
  };
}

async function main() {
  await ensureBookPlatformPolicy();
  await ensureGenresAndTags();

  const writer = await upsertWriterAccount();
  const seededStories = [];

  for (const story of stories) {
    seededStories.push(await upsertStory(writer.id, story));
  }

  console.log("Seeded demo writer account.");
  console.log(`Email: ${writerSeed.email}`);
  console.log(`Password: ${writerSeed.password}`);
  console.log(`Display name: ${writerSeed.displayName}`);
  console.log("Stories:");

  for (const story of seededStories) {
    console.log(`- ${story.title} (${story.slug}) -> ${story.chapterCount} chapters`);
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
