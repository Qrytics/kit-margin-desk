/** Billing plan catalogue and entitlements. Prices per spec "Suggested pricing tiers". */
export type PlanKey = "free" | "kit_desk" | "kit_desk_pro" | "plus";

export interface PlanDef {
  key: PlanKey;
  /** Name sent to Shopify billing (must match shopify.server.ts billing keys). */
  billingName: string | null;
  label: string;
  monthlyUsd: number;
  annualUsd: number;
  trialDays: number;
  maxKits: number | null;
  kitOrdersPerMonth: number | null;
  syncEnabled: boolean;
  csv: boolean;
  replenishment: boolean;
  buildMode: boolean;
  multiLocation: boolean;
  reconciliation: boolean;
  digest: boolean;
  blurb: string;
}

export const PLANS: Record<PlanKey, PlanDef> = {
  free: {
    key: "free", billingName: null, label: "Starter", monthlyUsd: 0, annualUsd: 0, trialDays: 0,
    maxKits: 3, kitOrdersPerMonth: 20, syncEnabled: true, csv: false, replenishment: false,
    buildMode: false, multiLocation: false, reconciliation: false, digest: false,
    blurb: "3 kits with full BOM and margin view. Live sync limited to 20 kit orders a month. Health check and dry run unlimited.",
  },
  kit_desk: {
    key: "kit_desk", billingName: "Kit Desk", label: "Kit Desk", monthlyUsd: 29, annualUsd: 290, trialDays: 14,
    maxKits: null, kitOrdersPerMonth: 1000, syncEnabled: true, csv: true, replenishment: false,
    buildMode: false, multiLocation: false, reconciliation: false, digest: false,
    blurb: "Unlimited kits and components, full sync including refunds and cancels, margin desk, cost alerts, CSV. One location, 1,000 kit orders a month.",
  },
  kit_desk_pro: {
    key: "kit_desk_pro", billingName: "Kit Desk Pro", label: "Kit Desk Pro", monthlyUsd: 59, annualUsd: 590, trialDays: 14,
    maxKits: null, kitOrdersPerMonth: 5000, syncEnabled: true, csv: true, replenishment: true,
    buildMode: true, multiLocation: true, reconciliation: true, digest: true,
    blurb: "Everything in Kit Desk plus replenishment and purchase orders, multi-location, build mode, nightly reconciliation and daily digest. 5,000 kit orders a month.",
  },
  plus: {
    key: "plus", billingName: "Kit Desk Plus", label: "Plus", monthlyUsd: 119, annualUsd: 1190, trialDays: 14,
    maxKits: null, kitOrdersPerMonth: null, syncEnabled: true, csv: true, replenishment: true,
    buildMode: true, multiLocation: true, reconciliation: true, digest: true,
    blurb: "Unlimited kit orders for Plus brands and small multi-store operators. Multi-store sync and accounting export arrive in V2.",
  },
};

export const planFromBillingName = (name: string | null | undefined): PlanKey => {
  const hit = Object.values(PLANS).find((p) => p.billingName && p.billingName === name);
  return hit ? hit.key : "free";
};

export type Feature = "csv" | "replenishment" | "buildMode" | "multiLocation" | "reconciliation" | "digest";

export function planAllows(plan: PlanKey, feature: Feature): boolean {
  return PLANS[plan][feature];
}

export interface KitQuota {
  allowed: boolean;
  reason?: string;
}

export function canCreateKit(plan: PlanKey, currentKits: number): KitQuota {
  const max = PLANS[plan].maxKits;
  if (max !== null && currentKits >= max)
    return { allowed: false, reason: `${PLANS[plan].label} includes ${max} kits. Upgrade for unlimited kits.` };
  return { allowed: true };
}

/** Over-cap kit orders are not decremented; they are logged "needs_review" so nothing is silently lost. */
export function withinOrderQuota(plan: PlanKey, kitOrdersThisMonth: number): boolean {
  const cap = PLANS[plan].kitOrdersPerMonth;
  return cap === null || kitOrdersThisMonth < cap;
}
