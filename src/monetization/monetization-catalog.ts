import { Prisma, PrismaClient } from "@prisma/client";

type MonetizationCatalogDb =
  | PrismaClient
  | Prisma.TransactionClient;

type PlanCodes = {
  arcaneAnnualPlanCode?: string | null;
  arcaneMonthlyPlanCode?: string | null;
  silverAnnualPlanCode?: string | null;
  silverMonthlyPlanCode?: string | null;
};

type FlutterwavePlanCodes = {
  arcaneAnnualPlanId?: string | null;
  arcaneMonthlyPlanId?: string | null;
  silverAnnualPlanId?: string | null;
  silverMonthlyPlanId?: string | null;
};

type PolarPlanCodes = {
  arcaneAnnualProductId?: string | null;
  arcaneMonthlyProductId?: string | null;
  silverAnnualProductId?: string | null;
  silverMonthlyProductId?: string | null;
};

type CatalogCurrency = "GHS" | "KES" | "NGN" | "USD" | "ZAR";
type PlanPriceKey = "arcane" | "silver";
type CoinPackagePriceKey = "bag" | "box" | "chest" | "pouch" | "vault";

type PriceProfile = {
  coinPackages: Record<CoinPackagePriceKey, number>;
  plans: Record<
    PlanPriceKey,
    {
      monthlyPriceCents: number;
      yearlyPriceCents: number;
    }
  >;
};

const PLAN_BASE = {
  arcane: {
    code: "arcane",
    description:
      "Premium membership with larger monthly coin grants and early access.",
    monthlyCoinGrant: 1200,
    name: "Arcane",
  },
  silver: {
    code: "silver",
    description: "Reader membership with ad-free reading and monthly coins.",
    monthlyCoinGrant: 500,
    name: "Silver",
  },
} as const;

const COIN_PACKAGE_BASE = {
  bag: {
    bonusCoins: 25,
    code: "bag",
    coins: 250,
    description: "Starter bundle with bonus coins",
    name: "Bag of Coins",
  },
  box: {
    bonusCoins: 100,
    code: "box",
    coins: 600,
    description: "Most popular coin bundle",
    name: "Box of Coins",
  },
  chest: {
    bonusCoins: 350,
    code: "chest",
    coins: 1500,
    description: "Large bundle for active premium readers",
    name: "Chest of Coins",
  },
  pouch: {
    bonusCoins: 0,
    code: "pouch",
    coins: 100,
    description: "Essential starter",
    name: "Pouch of Coins",
  },
  vault: {
    bonusCoins: 1000,
    code: "vault",
    coins: 3500,
    description: "High-value vault for dedicated readers",
    name: "Vault of Coins",
  },
} as const;

const GIFT_PRODUCT_BASE = [
  {
    code: "reader-note",
    coins: 20,
    description: "A lightweight appreciation gift for a creator you want to encourage.",
    icon: "ink_pen",
    name: "Reader Note",
  },
  {
    code: "spotlight-badge",
    coins: 60,
    description: "Highlights a standout chapter with a brighter support signal.",
    icon: "award_star",
    name: "Spotlight Badge",
  },
  {
    code: "story-boost",
    coins: 150,
    description: "A stronger gift for creators whose latest chapter deserves extra momentum.",
    icon: "rocket_launch",
    name: "Story Boost",
  },
  {
    code: "legend-patron",
    coins: 400,
    description: "Top-tier creator support for the stories you want to see grow faster.",
    icon: "diamond",
    name: "Legend Patron",
  },
] as const;

const PRICE_PROFILE_BY_CURRENCY: Record<CatalogCurrency, PriceProfile> = {
  GHS: {
    coinPackages: {
      bag: 3500,
      box: 7900,
      chest: 17900,
      pouch: 1500,
      vault: 34900,
    },
    plans: {
      arcane: {
        monthlyPriceCents: 18900,
        yearlyPriceCents: 181440,
      },
      silver: {
        monthlyPriceCents: 9900,
        yearlyPriceCents: 95040,
      },
    },
  },
  KES: {
    coinPackages: {
      bag: 28000,
      box: 65000,
      chest: 149000,
      pouch: 12000,
      vault: 289000,
    },
    plans: {
      arcane: {
        monthlyPriceCents: 170000,
        yearlyPriceCents: 1632000,
      },
      silver: {
        monthlyPriceCents: 90000,
        yearlyPriceCents: 864000,
      },
    },
  },
  NGN: {
    coinPackages: {
      bag: 120000,
      box: 280000,
      chest: 650000,
      pouch: 50000,
      vault: 1250000,
    },
    plans: {
      arcane: {
        monthlyPriceCents: 850000,
        yearlyPriceCents: 8160000,
      },
      silver: {
        monthlyPriceCents: 450000,
        yearlyPriceCents: 4320000,
      },
    },
  },
  USD: {
    coinPackages: {
      bag: 699,
      box: 1499,
      chest: 3499,
      pouch: 299,
      vault: 6999,
    },
    plans: {
      arcane: {
        monthlyPriceCents: 1999,
        yearlyPriceCents: 19190,
      },
      silver: {
        monthlyPriceCents: 999,
        yearlyPriceCents: 9590,
      },
    },
  },
  ZAR: {
    coinPackages: {
      bag: 3500,
      box: 7900,
      chest: 17900,
      pouch: 1500,
      vault: 34900,
    },
    plans: {
      arcane: {
        monthlyPriceCents: 23900,
        yearlyPriceCents: 229440,
      },
      silver: {
        monthlyPriceCents: 12900,
        yearlyPriceCents: 123840,
      },
    },
  },
};

function resolveCatalogCurrency(currency: string): CatalogCurrency {
  const normalizedCurrency = currency.trim().toUpperCase();

  if (normalizedCurrency in PRICE_PROFILE_BY_CURRENCY) {
    return normalizedCurrency as CatalogCurrency;
  }

  return "USD";
}

function getPriceProfile(currency: string) {
  return PRICE_PROFILE_BY_CURRENCY[resolveCatalogCurrency(currency)];
}

export function buildDefaultPlans({
  codes = {},
  flutterwaveCodes = {},
  polarCodes = {},
  currency = "USD",
}: {
  codes?: PlanCodes;
  flutterwaveCodes?: FlutterwavePlanCodes;
  polarCodes?: PolarPlanCodes;
  currency?: string;
} = {}) {
  const pricing = getPriceProfile(currency);

  return [
    {
      ...PLAN_BASE.silver,
      monthlyPriceCents: pricing.plans.silver.monthlyPriceCents,
      paystackAnnualPlanCode: codes.silverAnnualPlanCode ?? null,
      paystackMonthlyPlanCode: codes.silverMonthlyPlanCode ?? null,
      flutterwaveMonthlyPlanId: flutterwaveCodes.silverMonthlyPlanId ?? null,
      flutterwaveAnnualPlanId: flutterwaveCodes.silverAnnualPlanId ?? null,
      polarMonthlyProductId: polarCodes.silverMonthlyProductId ?? null,
      polarAnnualProductId: polarCodes.silverAnnualProductId ?? null,
      yearlyPriceCents: pricing.plans.silver.yearlyPriceCents,
    },
    {
      ...PLAN_BASE.arcane,
      monthlyPriceCents: pricing.plans.arcane.monthlyPriceCents,
      paystackAnnualPlanCode: codes.arcaneAnnualPlanCode ?? null,
      paystackMonthlyPlanCode: codes.arcaneMonthlyPlanCode ?? null,
      flutterwaveMonthlyPlanId: flutterwaveCodes.arcaneMonthlyPlanId ?? null,
      flutterwaveAnnualPlanId: flutterwaveCodes.arcaneAnnualPlanId ?? null,
      polarMonthlyProductId: polarCodes.arcaneMonthlyProductId ?? null,
      polarAnnualProductId: polarCodes.arcaneAnnualProductId ?? null,
      yearlyPriceCents: pricing.plans.arcane.yearlyPriceCents,
    },
  ] as const;
}

export function buildDefaultCoinPackages(currency = "USD") {
  const pricing = getPriceProfile(currency);

  return [
    {
      ...COIN_PACKAGE_BASE.pouch,
      priceCents: pricing.coinPackages.pouch,
    },
    {
      ...COIN_PACKAGE_BASE.bag,
      priceCents: pricing.coinPackages.bag,
    },
    {
      ...COIN_PACKAGE_BASE.box,
      priceCents: pricing.coinPackages.box,
    },
    {
      ...COIN_PACKAGE_BASE.chest,
      priceCents: pricing.coinPackages.chest,
    },
    {
      ...COIN_PACKAGE_BASE.vault,
      priceCents: pricing.coinPackages.vault,
    },
  ] as const;
}

export const defaultCoinPackages = buildDefaultCoinPackages("USD");

export function buildDefaultGiftProducts() {
  return [...GIFT_PRODUCT_BASE];
}

export const defaultGiftProducts = buildDefaultGiftProducts();

export async function ensureDefaultMonetizationCatalog(
  db: MonetizationCatalogDb,
  {
    codes = {},
    flutterwaveCodes = {},
    polarCodes = {},
    polarCoinProductId = null,
    currency = "USD",
  }: {
    codes?: PlanCodes;
    flutterwaveCodes?: FlutterwavePlanCodes;
    polarCodes?: PolarPlanCodes;
    polarCoinProductId?: string | null;
    currency?: string;
  } = {},
) {
  const plans = buildDefaultPlans({ codes, flutterwaveCodes, polarCodes, currency });
  const coinPackages = buildDefaultCoinPackages(currency);

  for (const plan of plans) {
    const existingPlan = await db.plan.findUnique({
      where: {
        code: plan.code,
      },
      select: {
        id: true,
      },
    });

    if (existingPlan) {
      await db.plan.update({
        where: {
          id: existingPlan.id,
        },
        data: {
          description: plan.description,
          monthlyCoinGrant: plan.monthlyCoinGrant,
          monthlyPriceCents: plan.monthlyPriceCents,
          name: plan.name,
          paystackAnnualPlanCode: plan.paystackAnnualPlanCode,
          paystackMonthlyPlanCode: plan.paystackMonthlyPlanCode,
          flutterwaveMonthlyPlanId: plan.flutterwaveMonthlyPlanId,
          flutterwaveAnnualPlanId: plan.flutterwaveAnnualPlanId,
          polarMonthlyProductId: plan.polarMonthlyProductId,
          polarAnnualProductId: plan.polarAnnualProductId,
          yearlyPriceCents: plan.yearlyPriceCents,
        },
      });
      continue;
    }

    await db.plan.create({
      data: {
        active: true,
        ...plan,
      },
    });
  }

  for (const coinPackage of coinPackages) {
    const existingCoinPackage = await db.coinPackage.findUnique({
      where: {
        code: coinPackage.code,
      },
      select: {
        id: true,
      },
    });

    if (existingCoinPackage) {
      await db.coinPackage.update({
        where: {
          id: existingCoinPackage.id,
        },
        data: {
          bonusCoins: coinPackage.bonusCoins,
          coins: coinPackage.coins,
          description: coinPackage.description,
          name: coinPackage.name,
          priceCents: coinPackage.priceCents,
          ...(polarCoinProductId ? { polarProductId: polarCoinProductId } : {}),
        },
      });
      continue;
    }

    await db.coinPackage.create({
      data: {
        active: true,
        ...coinPackage,
        ...(polarCoinProductId ? { polarProductId: polarCoinProductId } : {}),
      },
    });
  }

  return {
    coinPackageCodes: coinPackages.map((item) => item.code),
    planCodes: plans.map((item) => item.code),
  };
}
