/**
 * Marketplace seed — populates TaleStead with realistic content
 * so the app looks like it has been live for months.
 *
 * Creates: 200 writers, 8,000 stories, ~80K chapters, 500 readers,
 * and ~130K engagement records (ratings, reviews, comments, reactions,
 * follows, bookmarks, reading progress, activity events, etc.).
 *
 * Usage:  cd backend && npm run prisma:seed:marketplace
 */
import { hash } from "bcryptjs";
import {
  AdminBookReleaseMode,
  AdminBookVisibilityState,
  ChapterStatus,
  CreatorApplicationStatus,
  FollowTargetType,
  PrismaClient,
  ReadingListVisibility,
  StoryStatus,
  UserActivityEventType,
  UserRole,
  UserStatus,
} from "@prisma/client";
import { STORY_GENRES } from "../src/catalog/story-genres";
import dotenv from "dotenv";
dotenv.config();

/* ── DB connection (same pattern as seed-writer-demo.ts) ────── */
const directUrl = process.env.DIRECT_URL?.trim() || "";
const pooledUrl = process.env.DATABASE_URL?.trim() || "";
const databaseUrl = directUrl || pooledUrl;
if (!databaseUrl) throw new Error("DATABASE_URL or DIRECT_URL must be set.");
const separator = databaseUrl.includes("?") ? "&" : "?";
const prisma = new PrismaClient({
  datasources: { db: { url: `${databaseUrl}${separator}connection_limit=5` } },
});

/* ── Config ───────────────────────────────────────────────── */
const CFG = {
  writerCount: int("MARKETPLACE_SEED_WRITER_COUNT", 200),
  storiesPerWriter: int("MARKETPLACE_SEED_STORIES_PER_WRITER", 40),
  readerCount: int("MARKETPLACE_SEED_READER_COUNT", 500),
  rngSeed: int("MARKETPLACE_SEED_RNG_SEED", 42),
  writerConcurrency: int("MARKETPLACE_SEED_WRITER_CONCURRENCY", 10),
  readerBatch: int("MARKETPLACE_SEED_READER_BATCH", 50),
  chunkSize: int("MARKETPLACE_SEED_CHUNK_SIZE", 500),
  password: process.env.MARKETPLACE_SEED_PASSWORD?.trim() || "TaleSteadSeed123!",
};
function int(key: string, fallback: number) {
  const v = process.env[key];
  return v ? Math.max(1, parseInt(v, 10) || fallback) : fallback;
}

/* ── Seeded PRNG (Mulberry32) ─────────────────────────────── */
class Rng {
  private s: number;
  constructor(seed: number) { this.s = seed; }
  next(): number {
    this.s |= 0; this.s = (this.s + 0x6d2b79f5) | 0;
    let t = Math.imul(this.s ^ (this.s >>> 15), 1 | this.s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(min: number, max: number) { return min + Math.floor(this.next() * (max - min + 1)); }
  pick<T>(a: T[]): T { return a[this.int(0, a.length - 1)]; }
  pickN<T>(a: T[], n: number): T[] {
    const copy = [...a];
    const out: T[] = [];
    for (let i = 0; i < Math.min(n, copy.length); i++) {
      const idx = this.int(0, copy.length - 1);
      out.push(copy.splice(idx, 1)[0]);
    }
    return out;
  }
  bool(chance = 0.5) { return this.next() < chance; }
  float(min: number, max: number) { return min + this.next() * (max - min); }
}

const rng = new Rng(CFG.rngSeed);

/* ── Helpers ──────────────────────────────────────────────── */
function daysAgo(d: number) { return new Date(Date.now() - d * 86_400_000); }
function slugify(s: string) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
function chunk<T>(a: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}
async function createManyChunked<T extends Record<string, unknown>>(
  model: { createMany: (args: { data: T[]; skipDuplicates?: boolean }) => Promise<unknown> },
  rows: T[],
) {
  for (const ch of chunk(rows, CFG.chunkSize)) {
    await model.createMany({ data: ch, skipDuplicates: true });
  }
}
function log(msg: string) { console.log(`[marketplace-seed] ${msg}`); }
function elapsed(start: number) { return `${((Date.now() - start) / 1000).toFixed(1)}s`; }

/* ── Name / content pools ─────────────────────────────────── */
const FIRST_NAMES = [
  "Amara","Chidi","Fatima","Haruki","Ifeoma","Jun","Kezia","Lena","Malik","Nneka",
  "Oluwaseun","Priya","Ren","Saoirse","Tariq","Uma","Vivek","Wren","Xander","Yara",
  "Zara","Adaeze","Bolu","Celine","Daichi","Emeka","Faye","Gabriel","Hana","Idris",
  "Ayo","Kira","Leila","Mika","Nolan","Oba","Pema","Ravi","Suki","Tomas",
];
const LAST_NAMES = [
  "Okafor","Chen","Adeyemi","Nakamura","Owusu","Park","Mensah","Kim","Okonkwo","Sharma",
  "Tanaka","Morales","Obi","Afolabi","Diaz","Reyes","Hassan","Volkov","Dubois","Lindqvist",
  "Ngozi","Bello","Sato","Ortiz","Larsen","Osei","Patel","Quinn","Rivera","Suzuki",
  "Eze","Cheng","Abubakar","Yamamoto","Asante","Choi","Boateng","Lee","Nwosu","Gupta",
];

const LOCATIONS = [
  "Lagos, Nigeria","Nairobi, Kenya","Accra, Ghana","London, UK","New York, USA",
  "Tokyo, Japan","Berlin, Germany","Paris, France","Mumbai, India","São Paulo, Brazil",
  "Cape Town, South Africa","Toronto, Canada","Seoul, South Korea","Sydney, Australia",
  "Dubai, UAE","Singapore","Mexico City, Mexico","Stockholm, Sweden","Amsterdam, Netherlands",
  "Dublin, Ireland",
];

const MATURITY = ["everyone","13+","16+","18+"];
const AUDIENCES = ["Young Adult","New Adult","Adult","All Ages"];
const ACCENT_COLORS = [
  "#f4c025","#f97316","#ef4444","#8b5cf6","#3b82f6","#06b6d4","#10b981","#ec4899",
  "#f59e0b","#6366f1","#14b8a6","#d946ef","#0ea5e9","#22c55e","#e11d48","#a855f7",
  "#f43f5e","#84cc16","#0891b2","#c2410c",
];

const REACTION_TYPES = ["SHOCKED","SAD","LAUGHING","HEART","FIRE","SCARED"] as const;

/* ── Genre-keyed title generation ─────────────────────────── */
type TitlePool = { adj: string[]; noun: string[]; suffix: string[] };
const TITLE_POOLS: Record<string, TitlePool[]> = {
  romance: [
    { adj:["Forbidden","Stolen","Burning","Secret","Velvet"], noun:["Kiss","Heart","Promise","Desire","Affair"], suffix:["of Midnight","Unraveled","in Paris","Reborn","After Dark"] },
    { adj:["Reckless","Tender","Wild","Bittersweet","Captive"], noun:["Love","Vow","Flame","Touch","Devotion"], suffix:["Again","Forever","in Bloom","Undone","at Sunset"] },
  ],
  fantasy: [
    { adj:["Ember","Ashen","Silver","Shattered","Hollow"], noun:["Throne","Crown","Covenant","Dynasty","Citadel"], suffix:["of Ruin","Ascending","Reborn","Unchained","Eternal"] },
    { adj:["Crimson","Iron","Gilded","Dark","Frost"], noun:["Blade","Kingdom","Heir","Oracle","Veil"], suffix:["of Shadows","Rising","Awakened","Unbound","Forgotten"] },
  ],
  werewolf: [
    { adj:["Alpha's","Rogue","Midnight","Pack","Luna's"], noun:["Howl","Mate","Fang","Bond","Den"], suffix:["Rising","Unleashed","Under the Moon","Awakened","Reclaimed"] },
    { adj:["Feral","Shadow","Blood","Wild","Cursed"], noun:["Wolf","Hunt","Claw","Pact","Run"], suffix:["Unchained","of the Pack","Reborn","in Darkness","Bound"] },
  ],
  vampire: [
    { adj:["Crimson","Immortal","Dark","Bloodborn","Eternal"], noun:["Kiss","Thirst","Night","Coven","Vein"], suffix:["of Shadows","Awakened","Undying","Unbound","Rising"] },
    { adj:["Ancient","Velvet","Pale","Gothic","Hungry"], noun:["Court","Reign","Bloodline","Chalice","Fang"], suffix:["Reborn","in Crimson","Eternal","Unchained","of the Night"] },
  ],
  billionaire: [
    { adj:["The Billionaire's","His","Her","The CEO's","Empire"], noun:["Secret","Proposal","Contract","Heir","Deal"], suffix:["of Power","Unveiled","After Hours","Reclaimed","in Manhattan"] },
    { adj:["Ruthless","Golden","Diamond","Private","Platinum"], noun:["Offer","Empire","Legacy","Takeover","Throne"], suffix:["of Desire","Unmasked","Rising","at Midnight","Untold"] },
  ],
  mafia: [
    { adj:["The Don's","Ruthless","Silent","Deadly","Dark"], noun:["Bride","Empire","Code","Heir","Debt"], suffix:["of Blood","Unchained","Rising","in Shadows","Redeemed"] },
    { adj:["Scarred","Broken","Loyal","Merciless","Fallen"], noun:["Kingdom","Oath","Boss","Trigger","Family"], suffix:["of Honor","Undone","Reclaimed","at Midnight","Untouchable"] },
  ],
  ceo: [
    { adj:["The CEO's","His Executive","Her Boss's","Boardroom","Corner Office"], noun:["Secret","Game","Contract","Affair","Proposal"], suffix:["of Power","After Hours","Unveiled","Undone","Reclaimed"] },
    { adj:["Ambitious","Merciless","Forbidden","Executive","Powerful"], noun:["Deal","Merger","Rival","Empire","Throne"], suffix:["Rising","Unmasked","in Manhattan","of Desire","at the Top"] },
  ],
  "sci-fi": [
    { adj:["Stellar","Quantum","Neural","Orbital","Void"], noun:["Gate","Drift","Signal","Protocol","Engine"], suffix:["Rising","Unchained","of Tomorrow","Beyond","Rebooted"] },
    { adj:["Neon","Cyber","Galactic","Chrono","Zero"], noun:["Ark","Core","Nexus","Horizon","Pulse"], suffix:["Awakened","of the Stars","Reborn","Unbound","at the Edge"] },
  ],
  mystery: [
    { adj:["The Missing","Silent","Cold","Hidden","Final"], noun:["Witness","Case","Lie","Clue","Suspect"], suffix:["of Cedar Lane","Unveiled","Reopened","in the Dark","Unsolved"] },
    { adj:["Buried","Lost","Twisted","Vanishing","Deadly"], noun:["Truth","Secret","Evidence","Trail","File"], suffix:["Exposed","of Blackwood","Uncovered","at Midnight","Revisited"] },
  ],
  thriller: [
    { adj:["No","The Last","Dead","Blind","Final"], noun:["Escape","Warning","Man","Spot","Hour"], suffix:["Standing","Protocol","of Reckoning","Zone","Remaining"] },
    { adj:["Dark","Kill","Red","Silent","Breaking"], noun:["List","Switch","Line","Target","Point"], suffix:["Activated","of No Return","Rising","Engaged","Override"] },
  ],
  horror: [
    { adj:["The Hollow","Whispering","Rotting","Bleeding","Eyeless"], noun:["House","Woods","Doll","Mirror","Well"], suffix:["of Marrow","Awakened","Below","Unseen","Returns"] },
    { adj:["Crawling","Skinless","Pale","Consuming","Festering"], noun:["Thing","Dark","Mouth","Room","Grave"], suffix:["Inside","of Bone","Waiting","Beneath","Unburied"] },
  ],
  action: [
    { adj:["Strike","Iron","Rapid","Steel","Ghost"], noun:["Force","Zone","Point","Squad","Breach"], suffix:["Engaged","of Fire","Rising","Unleashed","Protocol"] },
    { adj:["Shadow","Black","Thunder","Phoenix","Viper"], noun:["Ops","Run","Team","Mission","Hunt"], suffix:["Reloaded","Deployed","of Valor","Active","Online"] },
  ],
  adventure: [
    { adj:["The Lost","Beyond","Uncharted","Wild","Legendary"], noun:["Expedition","Horizon","Isle","Passage","Compass"], suffix:["of Gold","Discovered","Reborn","Untamed","Awaits"] },
    { adj:["Brave","Daring","Epic","Ancient","Hidden"], noun:["Journey","Quest","Frontier","Trail","Map"], suffix:["of Wonders","Unchained","Rising","Found","Eternal"] },
  ],
  comedy: [
    { adj:["Absolutely","Perfectly","Totally","Hilariously","Accidentally"], noun:["Chaos","Disaster","Mess","Awkward","Trouble"], suffix:["in Love","at Work","Again","Next Door","Unleashed"] },
    { adj:["The Worst","My Ex's","Oops","Not Another","How I"], noun:["Date","Best Man","Roommate","Wedding","Vacation"], suffix:["from Hell","Survived","Gone Wrong","Unraveled","Happened"] },
  ],
  drama: [
    { adj:["The Weight","After","Between","Before","Beyond"], noun:["Silence","Us","the Fall","Everything","the Storm"], suffix:["Breaks","Remains","Shatters","Fades","Ends"] },
    { adj:["Fractured","Unspoken","Heavy","Glass","Paper"], noun:["Ties","Words","Hearts","Walls","Bridges"], suffix:["of Home","Burning","Rebuilt","Crumbling","Standing"] },
  ],
  "slice-of-life": [
    { adj:["Small","Quiet","Ordinary","Simple","Everyday"], noun:["Town","Days","Mornings","Joy","Moments"], suffix:["of Grace","Together","in Bloom","Passing","Ahead"] },
    { adj:["Warm","Gentle","Lazy","Soft","Slow"], noun:["Season","Chapter","Afternoon","Kitchen","Garden"], suffix:["of Mine","Again","Forever","Shared","Unfolding"] },
  ],
  historical: [
    { adj:["The Crown's","Imperial","Royal","Ancient","War-Torn"], noun:["Secret","Court","Rebellion","Dynasty","Legacy"], suffix:["of 1847","Rising","Unveiled","Reborn","in Exile"] },
    { adj:["Golden","Iron","Silk","Forgotten","Burning"], noun:["Age","Empire","Road","Palace","Siege"], suffix:["of the East","Undone","Restored","Unchained","of Kings"] },
  ],
  "lgbtq-plus": [
    { adj:["Proud","Fierce","Out","True","Bold"], noun:["Heart","Colors","Love","Voice","Light"], suffix:["of Mine","Rising","Unashamed","Reclaimed","in Full"] },
    { adj:["First","Found","Brave","Open","Real"], noun:["Kiss","Family","Pride","Story","Beginning"], suffix:["Again","Together","Unchained","of Us","Awakened"] },
  ],
  mature: [
    { adj:["Dark","Raw","Explicit","Burning","Twisted"], noun:["Desire","Obsession","Hunger","Edge","Games"], suffix:["Uncensored","After Dark","of Flesh","Unleashed","Undone"] },
    { adj:["Sinful","Forbidden","Primal","Wicked","Savage"], noun:["Pleasures","Nights","Instinct","Temptation","Craving"], suffix:["Exposed","Rising","of Shadow","Unchained","Unbound"] },
  ],
  cultivation: [
    { adj:["Heavenly","Immortal","Sacred","Jade","Celestial"], noun:["Dao","Realm","Pill","Sword","Spirit"], suffix:["Ascending","of Ten Thousand","Reforged","Unchained","Supreme"] },
    { adj:["Divine","Golden","Primordial","Eternal","Ancient"], noun:["Core","Path","Peak","Tribulation","Formation"], suffix:["Rising","Master","Boundless","of the Heavens","Awakened"] },
  ],
  litrpg: [
    { adj:["Level","System","Dungeon","Infinite","Max"], noun:["One","Reboot","Core","Grind","Quest"], suffix:["Online","Activated","of Shadows","Rising","Unchained"] },
    { adj:["Raid","Boss","Critical","Legendary","Class"], noun:["Mode","Drop","Hit","Skill","Ascension"], suffix:["Unlocked","Engaged","of Power","Evolved","Protocol"] },
  ],
  isekai: [
    { adj:["Reborn","Summoned","Transported","Awakened","Lost"], noun:["Hero","World","Kingdom","Skill","Life"], suffix:["in Another World","of Magic","Online","Restarted","Unchained"] },
    { adj:["The Weakest","Overpowered","Reluctant","Accidental","Chosen"], noun:["Sage","King","Saint","Chef","Blacksmith"], suffix:["of the New World","Rising","Reborn","Unleashed","Supreme"] },
  ],
  reincarnation: [
    { adj:["Second","Past","Reborn","Returned","Previous"], noun:["Life","Chance","Soul","Memory","Fate"], suffix:["of the Villainess","Awakened","Redo","Reclaimed","Reversed"] },
    { adj:["The Regressed","Forgotten","Eternal","Unwanted","Remembered"], noun:["Princess","Emperor","Hero","Saint","Scholar"], suffix:["Reborn","Returns","of a Past Life","Ascends","Unchained"] },
  ],
  "time-travel": [
    { adj:["Looping","Temporal","Chrono","Paradox","Rewound"], noun:["Days","Gate","Shift","Flux","Echo"], suffix:["of Tomorrow","Again","Reversed","Unraveled","Protocol"] },
    { adj:["The Last","Infinite","Broken","Stolen","Frozen"], noun:["Timeline","Moment","Clock","Reset","Era"], suffix:["Restored","of Second Chances","Unchained","Revisited","Engaged"] },
  ],
};

// Fallback pool for genres that might not have pools above
const DEFAULT_POOL: TitlePool[] = [
  { adj:["The","A","My","Our","One"], noun:["Story","Tale","Secret","Journey","Path"], suffix:["of Dreams","Rising","Untold","Reborn","Begins"] },
];

function genTitle(genre: string, used: Set<string>): string {
  const pools = TITLE_POOLS[genre] || DEFAULT_POOL;
  for (let attempt = 0; attempt < 100; attempt++) {
    const pool = rng.pick(pools);
    const title = `${rng.pick(pool.adj)} ${rng.pick(pool.noun)} ${rng.pick(pool.suffix)}`.trim();
    if (!used.has(title)) { used.add(title); return title; }
  }
  // Fallback: append a number
  const pool = rng.pick(pools);
  const base = `${rng.pick(pool.adj)} ${rng.pick(pool.noun)} ${rng.pick(pool.suffix)}`.trim();
  const title = `${base} ${used.size}`;
  used.add(title);
  return title;
}

const TAGS = [
  "forbidden-love","found-family","magic-academy","monsters","political-intrigue",
  "prophecy","slow-burn","enemies-to-lovers","second-chance","revenge",
  "redemption-arc","morally-grey","chosen-one","dark-academia","royal-court",
  "survival","heist","reluctant-hero","hidden-identity","star-crossed",
];

const SYNOPSIS_TEMPLATES = [
  "In a world where {concept}, {protagonist} must {challenge} before {stakes}.",
  "When {incident} shatters everything, {protagonist} is forced to {challenge}. But {twist} threatens to unravel it all.",
  "{protagonist} never expected to {incident}. Now, caught between {faction1} and {faction2}, the only way forward is through {stakes}.",
  "After years of {backstory}, {protagonist} discovers {revelation}. With {time} running out, {challenge} becomes the only option.",
  "They call {setting} the last safe place. {protagonist} knows better. Behind {facade}, {stakes} grows stronger every day.",
];
const CONCEPTS = [
  "power is inherited through blood","magic comes at a terrible price","the dead don't stay buried",
  "loyalty is the only currency","every wish has a cost","memories can be stolen",
  "the gods have abandoned humanity","machines have begun to dream","the night belongs to something ancient",
];
const CHALLENGES = [
  "navigate a web of lies","uncover the truth before it's too late","choose between duty and desire",
  "master abilities they never asked for","infiltrate the very system that oppresses them",
  "forge alliances with former enemies","survive a trial that kills most who enter",
];
const STAKES = [
  "the entire kingdom falls","everyone they love dies","the war begins again",
  "the ritual completes","the barrier breaks","the truth stays buried forever",
];
const TWISTS = [
  "a betrayal from within","an impossible attraction","a forgotten prophecy",
  "a power awakening inside them","an enemy who knows their secret",
];

function genSynopsis(): string {
  const tmpl = rng.pick(SYNOPSIS_TEMPLATES);
  return tmpl
    .replace("{concept}", rng.pick(CONCEPTS))
    .replace("{protagonist}", rng.pick(FIRST_NAMES))
    .replace("{challenge}", rng.pick(CHALLENGES))
    .replace("{stakes}", rng.pick(STAKES))
    .replace("{incident}", rng.pick(["a mysterious letter arrives","a death rocks the community","a stranger appears at their door","an ancient seal is broken"]))
    .replace("{twist}", rng.pick(TWISTS))
    .replace("{faction1}", rng.pick(["the Crown","the Guild","the Elders","the Syndicate"]))
    .replace("{faction2}", rng.pick(["the Resistance","the Outcasts","the Order","the Underground"]))
    .replace("{backstory}", rng.pick(["exile","hiding","silence","running","waiting"]))
    .replace("{revelation}", rng.pick(["a hidden bloodline","a conspiracy at the highest levels","a forbidden truth","the real reason for the war"]))
    .replace("{time}", rng.pick(["days","hours","a single moon cycle"]))
    .replace("{setting}", rng.pick(["the Citadel","the Borderlands","the Midnight District","the Undercity"]))
    .replace("{facade}", rng.pick(["the gilded walls","the polished surface","the friendly smiles"]))
    ;
}

/* ── Long chapter paragraph content ───────────────────────── */
const PARA_TEMPLATES = [
  "The air tasted of copper and old stone. {Name} pressed a hand against the wall, steadying themselves as the corridor stretched into darkness ahead. Every instinct screamed to turn back, but retreat was no longer an option — not after what they'd seen in the chamber below.",
  "Dawn broke reluctantly over the city, painting the skyline in shades of amber and bruised violet. The streets were empty at this hour, save for the occasional patrol cart and the distant rhythm of a street sweeper's broom. {Name} watched it all from the window of an apartment that wasn't theirs, holding a cup of tea that had gone cold hours ago.",
  "The marketplace was a riot of color and noise. Merchants shouted over one another in three languages, their stalls overflowing with silk, spices, and small mechanical wonders that whirred and clicked. {Name} moved through the crowd with practiced ease, fingers light, eyes sharp, cataloguing every face and filing away the ones that mattered.",
  "Rain hammered the tin roof with a sound like a thousand tiny fists. Inside the workshop, the only light came from a guttering oil lamp and the faint blue glow of the device on the table. {Name} adjusted the lens for the fourth time, muttering calculations under their breath. The numbers were right. They had to be right.",
  "The letter had arrived three days ago, and {Name} had read it exactly seventeen times since. Not because the words were unclear — they were devastatingly clear. But because clarity, in this case, was worse than confusion. The implications rewrote everything they thought they knew about their family, their past, and the reason they'd been sent away.",
  "Somewhere between the third and fourth watch, the forest went silent. Not the ordinary hush of nocturnal creatures settling into sleep, but the sudden, unnatural void that meant something large had entered the trees. {Name} gripped the hilt of the blade at their side and crouched lower behind the fallen oak, breathing as slowly as their hammering heart would allow.",
  "The council chamber smelled of beeswax and tension. Seven chairs faced the long table, and only five were occupied. The two empty seats spoke louder than anything the remaining members could say. {Name} stood at the foot of the table, back straight, jaw set, waiting for the question they already knew was coming — and dreading the answer they would have to give.",
  "The ocean stretched to the horizon, dark and unbroken except for the occasional crest of white foam. The ship had been at sea for twenty-three days, and supplies were beginning to thin. {Name} checked the charts again, tracing the route with a finger that shook slightly from hunger, or perhaps from the growing certainty that the map they'd been given was wrong.",
  "Music spilled from the ballroom like light from a cracked door — warm, golden, irresistible. {Name} paused at the threshold, adjusting the mask that concealed the upper half of their face. Inside, hundreds of guests danced beneath crystal chandeliers. Somewhere among them was the person they'd been hunting for seven months. Tonight, the hunt would end.",
  "The laboratory was a disaster. Glass shards crunched underfoot, reagent stains bloomed across the stone floor in chemical rainbows, and the acrid smell of burnt ozone hung in the air. {Name} surveyed the wreckage with a calm that surprised even them. The experiment had failed — spectacularly, violently, and possibly fatally for anyone who'd been standing where the blast originated. But the data. The data had survived.",
  "They met at the bridge, as they always did, when the moon hung low enough to touch the water. Neither of them spoke for a long time. The river murmured beneath their feet, carrying leaves and fragments of conversation from the village upstream. {Name} finally broke the silence with a question that had been building for weeks, its weight pressing against the inside of their ribs like a trapped bird.",
  "The prison walls were three feet thick and reinforced with iron bands that had been blessed — or cursed, depending on who you asked — by every major faith in the region. {Name} sat cross-legged on the cell floor, eyes closed, running through escape scenarios for the hundredth time. Scenarios one through ninety-seven had all ended in death. Ninety-eight and ninety-nine were merely catastrophic. Number one hundred, however, had a sliver of possibility — if the guard rotations hadn't changed since yesterday.",
  "The funeral was held on a Tuesday, which felt wrong. Important things shouldn't happen on Tuesdays. The sky was overcast but refused to rain, as if the weather itself couldn't commit. {Name} stood at the back of the crowd, close enough to hear the eulogies but far enough that no one would expect them to deliver one. They had written three versions and burned all of them.",
  "History, {Name} had decided long ago, was not a straight line but a spiral — revisiting the same themes with slightly different costumes. Standing in the archive vault, surrounded by centuries of carefully preserved documents, they could see the pattern as clearly as a spider sees its web. The current crisis was not new. It had happened before, under different names, with different faces. And every time, the same mistake was made at the crucial moment.",
  "The training yard was empty save for two figures circling each other in the pre-dawn mist. No words were exchanged — they'd moved past the need for verbal sparring weeks ago. {Name} feinted left, then drove forward with a strike that would have broken bone if it had connected. Their opponent deflected with maddening ease and countered with a sweep that sent {Name} sprawling into the damp earth. Again.",
  "Coffee. The answer to most of life's minor crises was coffee, and {Name} held onto this belief like a life raft as they stared at the screen full of error messages. The deadline was in six hours. The code was broken in ways that defied both logic and the compiler's ability to articulate. And the one person who understood the architecture had taken the day off for a dental appointment.",
  "The throne room had not changed in four hundred years. The same banners hung from the same iron hooks, the same mosaic floor depicted the same mythological victory, and the same uncomfortable chair sat atop the same three steps. What had changed was the person sitting in it. {Name} adjusted the crown — it was heavier than it looked — and faced the line of petitioners that stretched to the door and, reportedly, halfway down the corridor.",
  "The desert was beautiful in the way that dangerous things often are — vast, silent, and utterly indifferent to human survival. {Name} adjusted the cloth over their nose and mouth and checked the compass again. North-northwest, the informant had said. Two days' walk, the informant had said. The informant, {Name} was increasingly certain, had never set foot in this desert.",
  "Children have an instinct for secrets. They can feel them the way a cat feels an earthquake — some subtle vibration in the world that adults have learned to ignore. {Name} had been a watchful child, and that watchfulness had never fully gone away. Which was why, standing in the doorway of their childhood home for the first time in fifteen years, they noticed immediately that the wallpaper in the hallway had been changed — and what had been hidden behind it.",
  "The negotiations had been going on for fourteen hours. Empty coffee cups formed a barricade along the center of the table. Both sides had removed their jackets, loosened their ties, and abandoned all pretense of diplomatic courtesy somewhere around hour nine. {Name} was the only one still taking notes, their handwriting growing smaller and more cramped as the margins filled. Not because anyone would read the notes, but because the act of writing was the only thing keeping them from screaming.",
];

function genParagraphs(chapterNum: number, storyIndex: number): string[] {
  const count = rng.int(18, 30); // Long chapters: 18-30 paragraphs
  const paras: string[] = [];
  const names = rng.pickN(FIRST_NAMES, 3);
  for (let i = 0; i < count; i++) {
    const tmpl = PARA_TEMPLATES[(chapterNum * 7 + storyIndex * 3 + i) % PARA_TEMPLATES.length];
    paras.push(tmpl.replace(/\{Name\}/g, names[i % names.length]));
  }
  return paras;
}

const CHAPTER_TITLE_ADJ = [
  "The","A","Last","First","Final","Broken","Silent","Burning","Hidden","Falling",
  "Rising","Lost","Dark","Pale","Crimson","Iron","Golden","Cold","Hollow","Bitter",
];
const CHAPTER_TITLE_NOUN = [
  "Dawn","Door","Signal","Choice","Bridge","Shadow","Edge","Mask","Price","Fall",
  "Turn","Gate","Mark","Descent","Crossing","Oath","Veil","Fracture","Echo","Storm",
  "Reckoning","Vigil","Gambit","Threshold","Flame","Confession","Pursuit","Trial","Bond","Rift",
];
function genChapterTitle(num: number): string {
  return `${rng.pick(CHAPTER_TITLE_ADJ)} ${rng.pick(CHAPTER_TITLE_NOUN)}`;
}

/* Review / comment templates */
const REVIEW_TITLES = [
  "Couldn't put it down","A masterpiece","Really enjoyable read","Mixed feelings","Surprisingly good",
  "Best in its genre","A slow burn worth the wait","Not what I expected","Absolutely loved it","Solid storytelling",
  "Page-turner from start to finish","Emotional rollercoaster","Beautifully written","A hidden gem","Five stars easily",
];
const REVIEW_BODIES = [
  "The worldbuilding here is phenomenal. Every chapter reveals another layer of the setting, and the characters feel genuinely alive. I found myself thinking about the story long after putting it down.",
  "This story grabbed me from the first paragraph and didn't let go. The pacing is excellent — it knows when to slow down for character development and when to accelerate for the action scenes. Highly recommend.",
  "I've read a lot in this genre, and this one stands out. The protagonist is complex without being frustrating, and the supporting cast each has their own arc that feels earned. The prose is clean and evocative.",
  "Started reading out of curiosity and ended up binging the entire thing in one sitting. The dialogue is sharp, the plot twists are genuinely surprising, and the emotional beats land perfectly. More please.",
  "The author has a real talent for making you care about characters within a few paragraphs. The central conflict is compelling, and the resolution — while unexpected — feels true to everything that came before.",
  "A few pacing issues in the middle section, but the opening and climax are strong enough to carry the whole piece. The writing style is distinctive and confident. Looking forward to more from this author.",
  "Not usually my genre, but this story converted me. The themes are universal — identity, loyalty, sacrifice — and they're handled with nuance rather than cliché. Excellent work.",
  "I appreciate the research and detail that went into this. The setting feels authentic, the dialogue is natural, and the plot keeps you guessing. A few minor continuity issues, but nothing that ruined the experience.",
];
const COMMENT_BODIES = [
  "This chapter was incredible! I did NOT see that twist coming.",
  "The description here is so vivid, I felt like I was standing right there.",
  "Can we talk about that last line?? My jaw literally dropped.",
  "I've been waiting for this chapter and it did not disappoint.",
  "The character development in this story is unmatched. So good.",
  "This is quickly becoming my favorite story on the platform.",
  "The tension in this scene was perfectly paced. Chef's kiss.",
  "I love how the author weaves in the worldbuilding so naturally.",
  "Re-reading this chapter for the third time. It's that good.",
  "This story deserves way more attention. Sharing with everyone I know.",
  "That dialogue exchange was so well written. Felt completely real.",
  "Okay but the foreshadowing from chapter 2 just paid off and I'm shook.",
  "The way this chapter ended... I need the next one immediately.",
  "This paragraph gave me actual chills. Incredible writing.",
  "Beautifully done. The emotional weight of this chapter is immense.",
];

/* ================================================================
   PHASE 1: Platform setup
   ================================================================ */
async function phase1() {
  const t = Date.now();
  log("Phase 1: Platform setup...");

  await prisma.bookPlatformPolicy.upsert({
    where: { key: "default" },
    update: { defaultCoinCap: 50, defaultPremiumWindowHours: -1, defaultReleaseMode: AdminBookReleaseMode.PREMIUM_WINDOW },
    create: { key: "default", defaultCoinCap: 50, defaultPremiumWindowHours: -1, defaultReleaseMode: AdminBookReleaseMode.PREMIUM_WINDOW },
  });

  for (const g of STORY_GENRES) {
    await prisma.genre.upsert({ where: { slug: g.slug }, update: { name: g.name, description: g.description }, create: { slug: g.slug, name: g.name, description: g.description } });
  }

  for (const tag of TAGS) {
    const name = tag.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
    await prisma.tag.upsert({ where: { slug: tag }, update: { name }, create: { slug: tag, name } });
  }

  log(`Phase 1 complete (${STORY_GENRES.length} genres, ${TAGS.length} tags) [${elapsed(t)}]`);
}

/* ================================================================
   PHASE 2: Writers
   ================================================================ */
async function phase2() {
  const t = Date.now();
  log(`Phase 2: Creating ${CFG.writerCount} writers...`);

  const passwordHash = await hash(CFG.password, 3);
  const genreSlugs = STORY_GENRES.map(g => g.slug);
  const writerIds: string[] = [];

  for (let i = 0; i < CFG.writerCount; i++) {
    const firstName = FIRST_NAMES[i % FIRST_NAMES.length];
    const lastName = LAST_NAMES[(i + 7) % LAST_NAMES.length]; // offset to avoid same-index combos
    const displayName = `${firstName} ${lastName}`;
    const email = `writer.seed+${String(i).padStart(4, "0")}@talestead.local`;
    const primaryGenre = genreSlugs[i % genreSlugs.length];

    const user = await prisma.user.upsert({
      where: { email },
      update: { role: UserRole.CREATOR, status: UserStatus.ACTIVE },
      create: { email, role: UserRole.CREATOR, status: UserStatus.ACTIVE, emailVerifiedAt: new Date(), tosAcceptedAt: new Date(), tosVersion: "1.0" },
    });
    writerIds.push(user.id);

    await prisma.profile.upsert({
      where: { userId: user.id },
      update: { displayName },
      create: {
        userId: user.id, displayName,
        bio: `${displayName} writes ${STORY_GENRES.find(g => g.slug === primaryGenre)?.name ?? "fiction"} stories on TaleStead.`,
        location: LOCATIONS[i % LOCATIONS.length],
        tagline: `${STORY_GENRES.find(g => g.slug === primaryGenre)?.name ?? "Fiction"} author`,
        avatarUrl: `https://picsum.photos/seed/writer-${i}/200/200`,
        selectedGenres: [primaryGenre],
        onboardingCompletedAt: daysAgo(rng.int(30, 180)),
        termsAcceptedVersion: "1.0",
        termsAcceptedAt: daysAgo(rng.int(30, 180)),
      },
    });

    await prisma.credential.upsert({
      where: { userId: user.id },
      update: {},
      create: { userId: user.id, passwordHash },
    });

    await prisma.creatorApplication.upsert({
      where: { userId: user.id },
      update: { status: CreatorApplicationStatus.APPROVED },
      create: {
        userId: user.id, fullName: displayName, email,
        primaryGenre, experience: "Experienced writer on TaleStead.",
        motivation: "Passionate about serialized fiction.",
        status: CreatorApplicationStatus.APPROVED,
        submittedAt: daysAgo(rng.int(30, 180)),
        reviewedAt: daysAgo(rng.int(1, 29)),
      },
    });

    if ((i + 1) % 50 === 0) log(`  Writers: ${i + 1}/${CFG.writerCount}`);
  }

  log(`Phase 2 complete (${writerIds.length} writers) [${elapsed(t)}]`);
  return writerIds;
}

/* ================================================================
   PHASE 3: Stories + Chapters
   ================================================================ */
async function phase3(writerIds: string[]) {
  const t = Date.now();
  const totalStories = writerIds.length * CFG.storiesPerWriter;
  log(`Phase 3: Creating ${totalStories} stories with chapters...`);

  const genreSlugs = STORY_GENRES.map(g => g.slug);
  const usedTitles = new Set<string>();
  let totalChapters = 0;

  // Process writers in batches
  const writerBatches = chunk(writerIds, CFG.writerConcurrency);

  for (let bi = 0; bi < writerBatches.length; bi++) {
    const batch = writerBatches[bi];
    await Promise.all(batch.map(async (writerId, batchIdx) => {
      const writerGlobalIdx = bi * CFG.writerConcurrency + batchIdx;
      const primaryGenre = genreSlugs[writerGlobalIdx % genreSlugs.length];

      // Fetch writer profile for authorName
      const profile = await prisma.profile.findUnique({ where: { userId: writerId }, select: { displayName: true } });
      const authorName = profile?.displayName ?? `Writer ${writerGlobalIdx}`;

      for (let si = 0; si < CFG.storiesPerWriter; si++) {
        const storyGenre = si < 20 ? primaryGenre : genreSlugs[(writerGlobalIdx * 7 + si) % genreSlugs.length];
        const secondaryGenres = rng.pickN(genreSlugs.filter(g => g !== storyGenre), rng.int(0, 2));
        const storyGenreSlugs = [storyGenre, ...secondaryGenres];

        const title = genTitle(storyGenre, usedTitles);
        const slug = `seed-${String(writerGlobalIdx).padStart(4, "0")}-${String(si).padStart(3, "0")}-${slugify(title).slice(0, 40)}`;

        const publishedDaysAgo = rng.int(3, 180);
        const chapCount = rng.int(8, 15);
        const statusRoll = rng.next();
        const status = statusRoll < 0.75 ? StoryStatus.PUBLISHED : statusRoll < 0.85 ? StoryStatus.COMPLETED : statusRoll < 0.95 ? StoryStatus.HIATUS : StoryStatus.DRAFT;
        const isLive = status !== StoryStatus.DRAFT;
        const isFeatured = rng.bool(0.05);
        const isEditorPick = rng.bool(0.03);
        const maturity = rng.pick(MATURITY);
        const audience = rng.pick(AUDIENCES);

        // Create story
        const story = await prisma.story.upsert({
          where: { slug },
          update: { title, authorName, status, isLive, genreSlugs: storyGenreSlugs, tagSlugs: rng.pickN(TAGS, rng.int(1, 3)) },
          create: {
            slug, title, authorName, authorId: writerId,
            shortSynopsis: genSynopsis().slice(0, 200),
            synopsis: genSynopsis(),
            status, isLive, liveAt: isLive ? daysAgo(publishedDaysAgo) : null,
            language: "English", maturityRating: maturity, targetAudience: audience,
            featured: isFeatured, editorPick: isEditorPick,
            editorPickedAt: isEditorPick ? daysAgo(rng.int(1, publishedDaysAgo)) : null,
            genreSlugs: storyGenreSlugs, tagSlugs: rng.pickN(TAGS, rng.int(1, 3)),
            totalReads: rng.int(100, 50000),
            averageRating: rng.float(3.2, 5.0),
            reviewCount: rng.int(0, 200),
            publishedAt: isLive ? daysAgo(publishedDaysAgo) : null,
          },
        });

        // Story asset
        await prisma.storyAsset.upsert({
          where: { storyId: story.id },
          update: {},
          create: {
            storyId: story.id,
            coverImageUrl: `https://picsum.photos/seed/${slug}/400/600`,
            bannerImageUrl: `https://picsum.photos/seed/${slug}-banner/1200/400`,
            cardImageUrl: `https://picsum.photos/seed/${slug}-card/400/300`,
            accentColor: ACCENT_COLORS[(writerGlobalIdx + si) % ACCENT_COLORS.length],
          },
        });

        // Volume
        const vol = await prisma.storyVolume.upsert({
          where: { storyId_number: { storyId: story.id, number: 1 } },
          update: {},
          create: { storyId: story.id, number: 1, title: "Volume 1", sortOrder: 0 },
        });

        // Arc
        const existingArc = await prisma.storyArc.findFirst({ where: { storyId: story.id, sortOrder: 0 } });
        const arc = existingArc ?? await prisma.storyArc.create({
          data: { storyId: story.id, volumeId: vol.id, title: "Arc 1", sortOrder: 0 },
        });

        // Admin control
        await prisma.storyAdminControl.upsert({
          where: { storyId: story.id },
          update: { visibilityState: isLive ? AdminBookVisibilityState.LIVE : AdminBookVisibilityState.PENDING_APPROVAL },
          create: {
            storyId: story.id,
            visibilityState: isLive ? AdminBookVisibilityState.LIVE : AdminBookVisibilityState.PENDING_APPROVAL,
            globalCoinCap: 50, defaultPremiumWindowHours: -1,
            releaseMode: AdminBookReleaseMode.PREMIUM_WINDOW,
            reviewedAt: isLive ? daysAgo(publishedDaysAgo) : null,
          },
        });

        // Chapters + published chapters
        let latestChapterAt = daysAgo(publishedDaysAgo);
        for (let ci = 0; ci < chapCount; ci++) {
          const chapterNum = ci + 1;
          const chSlug = `chapter-${chapterNum}`;
          const chTitle = genChapterTitle(chapterNum);
          const chapDaysAgo = Math.max(1, publishedDaysAgo - ci * rng.int(2, 5));
          const pubAt = daysAgo(chapDaysAgo);
          if (pubAt > latestChapterAt) latestChapterAt = pubAt;

          const isPremium = ci >= 5 && rng.bool(0.3);
          const paras = genParagraphs(ci, writerGlobalIdx * 100 + si);
          const wordCount = paras.join(" ").split(/\s+/).length;

          const chapter = await prisma.chapter.upsert({
            where: { storyId_slug: { storyId: story.id, slug: chSlug } },
            update: { title: chTitle, chapterNumber: chapterNum, status: ChapterStatus.PUBLISHED },
            create: {
              storyId: story.id, volumeId: vol.id, arcId: arc.id,
              slug: chSlug, title: chTitle, chapterNumber: chapterNum,
              status: ChapterStatus.PUBLISHED,
              excerpt: paras[0]?.slice(0, 200) ?? "",
              wordCount, readingMinutes: Math.ceil(wordCount / 250),
              bodyDraft: paras.join("\n\n"),
              premiumEnabled: isPremium, coinUnlockPrice: isPremium ? 50 : 0,
            },
          });

          await prisma.publishedChapter.upsert({
            where: { storyId_slug: { storyId: story.id, slug: chSlug } },
            update: { title: chTitle, chapterNumber: chapterNum, bodyParagraphs: paras },
            create: {
              storyId: story.id, chapterId: chapter.id,
              slug: chSlug, title: chTitle, chapterNumber: chapterNum,
              bodyParagraphs: paras,
              premium: isPremium, coinUnlockPrice: isPremium ? 50 : 0,
              publishedAt: pubAt,
            },
          });

          totalChapters++;
        }

        // Update latestChapterAt
        await prisma.story.update({ where: { id: story.id }, data: { latestChapterAt } });
      }
    }));

    const storiesSoFar = (bi + 1) * CFG.writerConcurrency * CFG.storiesPerWriter;
    log(`  Batch ${bi + 1}/${writerBatches.length} (${Math.min(storiesSoFar, totalStories)} stories, ${totalChapters} chapters)`);
  }

  log(`Phase 3 complete (${totalStories} stories, ${totalChapters} chapters) [${elapsed(t)}]`);
}

/* ================================================================
   PHASE 4: Readers
   ================================================================ */
async function phase4() {
  const t = Date.now();
  log(`Phase 4: Creating ${CFG.readerCount} readers...`);

  const passwordHash = await hash(CFG.password, 3);
  const readerIds: string[] = [];

  for (let i = 0; i < CFG.readerCount; i++) {
    const firstName = FIRST_NAMES[(i + 13) % FIRST_NAMES.length];
    const lastName = LAST_NAMES[(i + 19) % LAST_NAMES.length];
    const displayName = `${firstName} ${lastName}`;
    const email = `reader.seed+${String(i).padStart(4, "0")}@talestead.local`;

    const user = await prisma.user.upsert({
      where: { email },
      update: {},
      create: { email, role: UserRole.READER, status: UserStatus.ACTIVE, emailVerifiedAt: new Date(), tosAcceptedAt: new Date(), tosVersion: "1.0" },
    });
    readerIds.push(user.id);

    await prisma.profile.upsert({
      where: { userId: user.id },
      update: {},
      create: {
        userId: user.id, displayName,
        bio: `Avid reader on TaleStead. Loves ${rng.pick(STORY_GENRES).name} and ${rng.pick(STORY_GENRES).name}.`,
        location: rng.pick(LOCATIONS),
        avatarUrl: `https://picsum.photos/seed/reader-${i}/200/200`,
        selectedGenres: rng.pickN(STORY_GENRES.map(g => g.slug), rng.int(2, 5)),
        onboardingCompletedAt: daysAgo(rng.int(7, 150)),
        termsAcceptedVersion: "1.0",
        termsAcceptedAt: daysAgo(rng.int(7, 150)),
      },
    });

    await prisma.credential.upsert({
      where: { userId: user.id },
      update: {},
      create: { userId: user.id, passwordHash },
    });

    if ((i + 1) % 100 === 0) log(`  Readers: ${i + 1}/${CFG.readerCount}`);
  }

  log(`Phase 4 complete (${readerIds.length} readers) [${elapsed(t)}]`);
  return readerIds;
}

/* ================================================================
   PHASE 5: Engagement
   ================================================================ */
async function phase5(readerIds: string[], writerIds: string[]) {
  const t = Date.now();
  log("Phase 5: Seeding engagement data...");

  // Fetch all seed stories with their published chapters
  const allStories = await prisma.story.findMany({
    where: { slug: { startsWith: "seed-" } },
    select: {
      id: true, slug: true, authorId: true,
      publishedChapters: { select: { id: true, chapterNumber: true, bodyParagraphs: true }, orderBy: { chapterNumber: "asc" } },
    },
  });
  log(`  Found ${allStories.length} seed stories with chapters`);

  if (allStories.length === 0) { log("  No stories found, skipping engagement."); return; }

  // Clear existing engagement for seed readers (idempotent re-run)
  log("  Clearing existing engagement for seed readers...");
  const readerIdSet = readerIds;
  // Delete in FK-safe order
  await prisma.reviewVote.deleteMany({ where: { userId: { in: readerIdSet } } });
  await prisma.paragraphReaction.deleteMany({ where: { userId: { in: readerIdSet } } });
  await prisma.chapterReaction.deleteMany({ where: { userId: { in: readerIdSet } } });
  await prisma.comment.deleteMany({ where: { userId: { in: readerIdSet } } });
  await prisma.review.deleteMany({ where: { userId: { in: readerIdSet } } });
  await prisma.storyRating.deleteMany({ where: { userId: { in: readerIdSet } } });
  await prisma.chapterReadEvent.deleteMany({ where: { userId: { in: readerIdSet } } });
  await prisma.userActivityEvent.deleteMany({ where: { userId: { in: readerIdSet } } });
  await prisma.activityFeedEvent.deleteMany({ where: { userId: { in: readerIdSet } } });
  await prisma.bookmark.deleteMany({ where: { userId: { in: readerIdSet } } });
  await prisma.readingProgress.deleteMany({ where: { userId: { in: readerIdSet } } });
  await prisma.readingListItem.deleteMany({ where: { readingList: { userId: { in: readerIdSet } } } });
  await prisma.readingList.deleteMany({ where: { userId: { in: readerIdSet } } });
  await prisma.follow.deleteMany({ where: { userId: { in: readerIdSet } } });
  await prisma.dailyCheckIn.deleteMany({ where: { userId: { in: readerIdSet } } });
  await prisma.rewardLedgerEntry.deleteMany({ where: { userId: { in: readerIdSet } } });
  await prisma.rewardWallet.deleteMany({ where: { userId: { in: readerIdSet } } });
  log("  Engagement cleared.");

  // Batch process readers
  const readerBatches = chunk(readerIds, CFG.readerBatch);
  let totalFollows = 0, totalRatings = 0, totalReviews = 0, totalComments = 0;
  let totalReactions = 0, totalProgress = 0, totalBookmarks = 0, totalReadEvents = 0;

  // Collect all reviews for later voting
  const allReviewIds: string[] = [];

  for (let bi = 0; bi < readerBatches.length; bi++) {
    const batch = readerBatches[bi];

    for (const readerId of batch) {
      // Each reader engages with 10-30 stories
      const storyCount = rng.int(10, 30);
      const selectedStories = rng.pickN(allStories, Math.min(storyCount, allStories.length));

      // Follow some writers
      const authorIds = Array.from(new Set(selectedStories.map(s => s.authorId).filter(Boolean))) as string[];
      const followWriters = rng.pickN(authorIds, rng.int(1, Math.min(5, authorIds.length)));
      for (const authorId of followWriters) {
        const subjectKey = `author:${authorId}`;
        await prisma.follow.upsert({
          where: { userId_subjectKey: { userId: readerId, subjectKey } },
          update: {},
          create: { userId: readerId, targetType: FollowTargetType.AUTHOR, subjectKey, targetUserId: authorId },
        });
        totalFollows++;
      }

      for (const story of selectedStories) {
        const chapters = story.publishedChapters;
        if (chapters.length === 0) continue;

        // Follow story
        if (rng.bool(0.6)) {
          const subjectKey = `story:${story.id}`;
          await prisma.follow.upsert({
            where: { userId_subjectKey: { userId: readerId, subjectKey } },
            update: {},
            create: { userId: readerId, targetType: FollowTargetType.STORY, subjectKey, storyId: story.id },
          });
          totalFollows++;
        }

        // Reading progress
        const chaptersRead = rng.int(1, chapters.length);
        const lastChapter = chapters[chaptersRead - 1];
        const progressPercent = chaptersRead === chapters.length ? 100 : rng.int(10, 95);
        await prisma.readingProgress.create({
          data: {
            userId: readerId, storyId: story.id,
            publishedChapterId: lastChapter.id,
            progressPercent, paragraphIndex: rng.int(0, 10),
            lastReadAt: daysAgo(rng.int(0, 30)),
          },
        });
        totalProgress++;

        // Chapter read events + activity events
        for (let ci = 0; ci < chaptersRead && ci < 6; ci++) { // Cap at 6 to control volume
          const ch = chapters[ci];
          const readDate = daysAgo(rng.int(0, 60));
          try {
            await prisma.chapterReadEvent.create({
              data: {
                userId: readerId, storyId: story.id, publishedChapterId: ch.id,
                readDate, completed: ci < chaptersRead - 1, paragraphIndex: 0,
                maxProgressPercent: ci < chaptersRead - 1 ? 100 : progressPercent,
                completedAt: ci < chaptersRead - 1 ? readDate : null,
              },
            });
            totalReadEvents++;
          } catch { /* unique constraint on re-run */ }

          try {
            await prisma.userActivityEvent.create({
              data: {
                userId: readerId, type: UserActivityEventType.READ_CHAPTER,
                referenceId: ch.id, numericValue: 1, happenedAt: readDate,
              },
            });
          } catch { /* ok */ }
        }

        // Bookmark some chapters
        if (rng.bool(0.4)) {
          const ch = rng.pick(chapters.slice(0, chaptersRead));
          try {
            await prisma.bookmark.create({
              data: { userId: readerId, storyId: story.id, publishedChapterId: ch.id },
            });
            totalBookmarks++;
          } catch { /* unique */ }
        }

        // Rating
        if (rng.bool(0.5)) {
          try {
            await prisma.storyRating.create({
              data: { userId: readerId, storyId: story.id, rating: rng.int(3, 5) },
            });
            totalRatings++;
          } catch { /* unique */ }
        }

        // Review (less common)
        if (rng.bool(0.08)) {
          try {
            const review = await prisma.review.create({
              data: {
                userId: readerId, storyId: story.id,
                rating: rng.int(3, 5),
                title: rng.pick(REVIEW_TITLES),
                body: rng.pick(REVIEW_BODIES),
                containsSpoilers: rng.bool(0.15),
              },
            });
            allReviewIds.push(review.id);
            totalReviews++;
          } catch { /* unique */ }
        }

        // Comment on a chapter
        if (rng.bool(0.25)) {
          const ch = rng.pick(chapters.slice(0, chaptersRead));
          try {
            await prisma.comment.create({
              data: {
                userId: readerId, storyId: story.id, publishedChapterId: ch.id,
                body: rng.pick(COMMENT_BODIES), depth: 0,
              },
            });
            totalComments++;
          } catch { /* ok */ }
        }

        // Paragraph reactions (on some chapters)
        if (rng.bool(0.3)) {
          const ch = rng.pick(chapters.slice(0, chaptersRead));
          const paraCount = ch.bodyParagraphs?.length ?? 0;
          if (paraCount > 0) {
            const paraIdx = rng.int(0, paraCount - 1);
            try {
              await prisma.paragraphReaction.create({
                data: {
                  userId: readerId, publishedChapterId: ch.id,
                  paragraphIndex: paraIdx,
                  reactionType: rng.pick([...REACTION_TYPES]),
                },
              });
              totalReactions++;
            } catch { /* unique */ }
          }
        }

        // Chapter reaction
        if (rng.bool(0.35)) {
          const ch = rng.pick(chapters.slice(0, chaptersRead));
          try {
            await prisma.chapterReaction.create({
              data: {
                userId: readerId, publishedChapterId: ch.id,
                reactionType: rng.pick([...REACTION_TYPES]),
              },
            });
            totalReactions++;
          } catch { /* unique */ }
        }
      }

      // Reading lists
      const listCount = rng.int(1, 3);
      for (let li = 0; li < listCount; li++) {
        const listName = `${rng.pick(["Best","Favorite","Must-Read","Top","Weekend"])} ${rng.pick(STORY_GENRES).name}`;
        const shareSlug = `seed-reader-${readerId.slice(-8)}-list-${li}`;
        try {
          const list = await prisma.readingList.create({
            data: {
              userId: readerId, name: listName, shareSlug,
              visibility: rng.bool(0.6) ? ReadingListVisibility.PUBLIC : ReadingListVisibility.PRIVATE,
            },
          });
          const listStories = rng.pickN(selectedStories, rng.int(3, 8));
          for (const s of listStories) {
            try {
              await prisma.readingListItem.create({
                data: { readingListId: list.id, storyId: s.id },
              });
            } catch { /* unique */ }
          }
        } catch { /* unique shareSlug */ }
      }

      // Reward wallet + check-ins (subset)
      if (rng.bool(0.4)) {
        const points = rng.int(100, 5000);
        const streak = rng.int(0, 30);
        const wallet = await prisma.rewardWallet.create({
          data: { userId: readerId, balancePoints: points, streakDays: streak, lastCheckInAt: daysAgo(rng.int(0, 3)) },
        });

        // Some daily check-ins
        for (let d = 0; d < rng.int(3, 15); d++) {
          await prisma.dailyCheckIn.create({
            data: { userId: readerId, checkedInAt: daysAgo(d), rewardPoints: 50 },
          });
        }
      }
    }

    log(`  Readers ${(bi + 1) * CFG.readerBatch}/${readerIds.length} — follows:${totalFollows} ratings:${totalRatings} reviews:${totalReviews} comments:${totalComments} reactions:${totalReactions}`);
  }

  // Review votes (readers vote on each other's reviews)
  log("  Seeding review votes...");
  let totalVotes = 0;
  for (const reviewId of allReviewIds.slice(0, 2000)) { // Cap for performance
    const voters = rng.pickN(readerIds, rng.int(1, 5));
    for (const voterId of voters) {
      try {
        await prisma.reviewVote.create({
          data: { userId: voterId, reviewId, helpful: rng.bool(0.8) },
        });
        totalVotes++;
      } catch { /* unique */ }
    }
  }

  log(`Phase 5 complete — follows:${totalFollows} ratings:${totalRatings} reviews:${totalReviews} comments:${totalComments} reactions:${totalReactions} bookmarks:${totalBookmarks} readEvents:${totalReadEvents} votes:${totalVotes} [${elapsed(t)}]`);
}

/* ================================================================
   PHASE 6: Summary refresh
   ================================================================ */
async function phase6() {
  const t = Date.now();
  log("Phase 6: Refreshing story summaries...");

  const stories = await prisma.story.findMany({
    where: { slug: { startsWith: "seed-" } },
    select: { id: true },
  });

  let updated = 0;
  for (const ch of chunk(stories, 100)) {
    await Promise.all(ch.map(async (story) => {
      const [ratingAgg, reviewCount, readCount] = await Promise.all([
        prisma.storyRating.aggregate({ where: { storyId: story.id }, _avg: { rating: true }, _count: true }),
        prisma.review.count({ where: { storyId: story.id } }),
        prisma.readingProgress.count({ where: { storyId: story.id } }),
      ]);
      await prisma.story.update({
        where: { id: story.id },
        data: {
          averageRating: ratingAgg._avg.rating ?? 0,
          reviewCount,
          totalReads: readCount * rng.int(5, 20), // Multiply for realistic read counts
        },
      });
      updated++;
    }));
  }

  log(`Phase 6 complete (${updated} stories updated) [${elapsed(t)}]`);
}

/* ================================================================
   MAIN
   ================================================================ */
async function main() {
  const t = Date.now();
  log("=== MARKETPLACE SEED START ===");
  log(`Config: ${CFG.writerCount} writers, ${CFG.storiesPerWriter} stories/writer, ${CFG.readerCount} readers`);

  await phase1();
  const writerIds = await phase2();
  await phase3(writerIds);
  const readerIds = await phase4();
  await phase5(readerIds, writerIds);
  await phase6();

  log(`=== MARKETPLACE SEED COMPLETE === [${elapsed(t)}]`);
}

main()
  .then(async () => { await prisma.$disconnect(); })
  .catch(async (err) => { console.error(err); await prisma.$disconnect(); process.exit(1); });
