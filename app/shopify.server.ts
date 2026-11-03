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

export const API_VERSION = ApiVersion.April26;

/** Plan keys here are the names Shopify shows the merchant; see core/plans.ts for entitlements. */
export const BILLING_PLANS = {
  [PLANS.kit_desk.billingName!]: {
    trialDays: PLANS.kit_desk.trialDays,
    replacementBehavior: BillingReplacementBehavior.ApplyImmediately,
    lineItems: [{ amount: PLANS.kit_desk.monthlyUsd, currencyCode: "USD", interval: BillingInterval.Every30Days }],
  },
  [PLANS.kit_desk_pro.billingName!]: {
    trialDays: PLANS.kit_desk_pro.trialDays,
    replacementBehavior: BillingReplacementBehavior.ApplyImmediately,
    lineItems: [{ amount: PLANS.kit_desk_pro.monthlyUsd, currencyCode: "USD", interval: BillingInterval.Every30Days }],
  },
  [PLANS.plus.billingName!]: {
    trialDays: PLANS.plus.trialDays,
    replacementBehavior: BillingReplacementBehavior.ApplyImmediately,
    lineItems: [{ amount: PLANS.plus.monthlyUsd, currencyCode: "USD", interval: BillingInterval.Every30Days }],
  },
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
