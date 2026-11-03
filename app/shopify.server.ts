import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  BillingInterval,
  BillingReplacementBehavior,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { PLANS } from "./core/plans";

type BillingPlan = NonNullable<Parameters<typeof shopifyApp>[0]["billing"]>[string];

export const API_VERSION = ApiVersion.April26;

const recurring = (usd: number, trialDays: number): BillingPlan => ({
  trialDays,
  replacementBehavior: BillingReplacementBehavior.ApplyImmediately,
  lineItems: [{ amount: usd, currencyCode: "USD", interval: BillingInterval.Every30Days }],
});

/** Keys are the plan names Shopify shows the merchant; see core/plans.ts for entitlements. */
export const BILLING_PLANS: Record<string, BillingPlan> = {
  [PLANS.kit_desk.billingName!]: recurring(PLANS.kit_desk.monthlyUsd, PLANS.kit_desk.trialDays),
  [PLANS.kit_desk_pro.billingName!]: recurring(PLANS.kit_desk_pro.monthlyUsd, PLANS.kit_desk_pro.trialDays),
  [PLANS.plus.billingName!]: recurring(PLANS.plus.monthlyUsd, PLANS.plus.trialDays),
};

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: API_VERSION,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  billing: BILLING_PLANS,
  future: {},
});

export default shopify;
export const authenticate = shopify.authenticate;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
export const unauthenticated = shopify.unauthenticated;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
