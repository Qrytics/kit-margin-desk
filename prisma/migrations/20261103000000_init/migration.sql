-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "KitMode" AS ENUM ('assemble_on_order', 'pre_assembled');

-- CreateEnum
CREATE TYPE "LedgerSource" AS ENUM ('order', 'refund', 'cancel', 'fulfillment', 'build', 'po_receipt', 'reconciliation', 'manual', 'undo');

-- CreateEnum
CREATE TYPE "LedgerStatus" AS ENUM ('pending', 'applied', 'skipped', 'failed', 'needs_review');

-- CreateEnum
CREATE TYPE "PoStatus" AS ENUM ('draft', 'sent', 'partially_received', 'received', 'closed');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "syncEnabled" BOOLEAN NOT NULL DEFAULT false,
    "syncEnabledAt" TIMESTAMP(3),
    "syncPaused" BOOLEAN NOT NULL DEFAULT false,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMP(3),

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Kit" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "shopifyVariantId" TEXT NOT NULL,
    "mode" "KitMode" NOT NULL DEFAULT 'assemble_on_order',
    "manageAvailability" BOOLEAN NOT NULL DEFAULT false,
    "packagingCostCents" INTEGER NOT NULL DEFAULT 0,
    "laborMinutes" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "laborRateCents" INTEGER,
    "landedUpliftBps" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Kit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BomLine" (
    "id" TEXT NOT NULL,
    "kitId" TEXT NOT NULL,
    "componentVariantId" TEXT,
    "componentInventoryItemId" TEXT,
    "componentKitId" TEXT,
    "qtyPerKit" DECIMAL(12,4) NOT NULL,
    "wasteBps" INTEGER NOT NULL DEFAULT 0,
    "uomLabel" TEXT NOT NULL DEFAULT 'pcs',
    "sort" INTEGER NOT NULL DEFAULT 0,
    "broken" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "BomLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComponentMeta" (
    "shopId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "supplierName" TEXT,
    "supplierSku" TEXT,
    "packSize" INTEGER,
    "leadTimeDays" INTEGER,
    "reorderPointOverride" INTEGER,
    "avgCostCents" INTEGER,
    "lastKnownCostCents" INTEGER,

    CONSTRAINT "ComponentMeta_pkey" PRIMARY KEY ("shopId","variantId")
);

-- CreateTable
CREATE TABLE "ProcessedEvent" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "payloadHash" TEXT,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderLineState" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "kitVariantId" TEXT NOT NULL,
    "orderedQty" INTEGER,
    "refunds" JSONB NOT NULL DEFAULT '{}',
    "cancelledQty" INTEGER NOT NULL DEFAULT 0,
    "netApplied" INTEGER NOT NULL DEFAULT 0,
    "bomSnapshot" JSONB NOT NULL DEFAULT '{}',
    "locationId" TEXT,
    "locationAssumed" BOOLEAN NOT NULL DEFAULT false,
    "frozen" BOOLEAN NOT NULL DEFAULT false,
    "orderName" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderLineState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaleLine" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "refundedQty" INTEGER NOT NULL DEFAULT 0,
    "unitPriceCents" INTEGER NOT NULL,
    "soldAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SaleLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerBatch" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "sourceType" "LedgerSource" NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "status" "LedgerStatus" NOT NULL DEFAULT 'pending',
    "note" TEXT,
    "undoneByBatchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "sourceType" "LedgerSource" NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "sku" TEXT,
    "locationId" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "beforeQty" INTEGER,
    "afterQty" INTEGER,
    "status" "LedgerStatus" NOT NULL DEFAULT 'pending',
    "locationAssumed" BOOLEAN NOT NULL DEFAULT false,
    "lineKey" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "supplierName" TEXT NOT NULL,
    "status" "PoStatus" NOT NULL DEFAULT 'draft',
    "expectedDate" TIMESTAMP(3),
    "freightCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PoLine" (
    "id" TEXT NOT NULL,
    "poId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "qtyOrdered" INTEGER NOT NULL,
    "qtyReceived" INTEGER NOT NULL DEFAULT 0,
    "unitCostCents" INTEGER NOT NULL,

    CONSTRAINT "PoLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CostChange" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "oldCents" INTEGER NOT NULL,
    "newCents" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "dismissed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CostChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "dedupeKey" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "doneAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogScan" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "variantCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "CatalogScan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogVariant" (
    "shopId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "sku" TEXT,
    "data" JSONB NOT NULL,

    CONSTRAINT "CatalogVariant_pkey" PRIMARY KEY ("shopId","variantId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Shop_domain_key" ON "Shop"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "Kit_shopId_shopifyVariantId_key" ON "Kit"("shopId", "shopifyVariantId");

-- CreateIndex
CREATE INDEX "BomLine_kitId_idx" ON "BomLine"("kitId");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessedEvent_shopId_idempotencyKey_key" ON "ProcessedEvent"("shopId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "OrderLineState_shopId_orderId_lineId_key" ON "OrderLineState"("shopId", "orderId", "lineId");

-- CreateIndex
CREATE INDEX "SaleLine_shopId_soldAt_idx" ON "SaleLine"("shopId", "soldAt");

-- CreateIndex
CREATE UNIQUE INDEX "SaleLine_shopId_orderId_lineId_key" ON "SaleLine"("shopId", "orderId", "lineId");

-- CreateIndex
CREATE INDEX "LedgerBatch_shopId_createdAt_idx" ON "LedgerBatch"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "LedgerEntry_shopId_createdAt_idx" ON "LedgerEntry"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "LedgerEntry_batchId_idx" ON "LedgerEntry"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_shopId_number_key" ON "PurchaseOrder"("shopId", "number");

-- CreateIndex
CREATE INDEX "CostChange_shopId_createdAt_idx" ON "CostChange"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "Job_doneAt_runAt_idx" ON "Job"("doneAt", "runAt");

-- CreateIndex
CREATE UNIQUE INDEX "Job_shopId_dedupeKey_key" ON "Job"("shopId", "dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogScan_operationId_key" ON "CatalogScan"("operationId");

-- CreateIndex
CREATE INDEX "CatalogScan_shopId_startedAt_idx" ON "CatalogScan"("shopId", "startedAt");

-- CreateIndex
CREATE INDEX "CatalogVariant_shopId_sku_idx" ON "CatalogVariant"("shopId", "sku");

-- AddForeignKey
ALTER TABLE "Kit" ADD CONSTRAINT "Kit_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BomLine" ADD CONSTRAINT "BomLine_kitId_fkey" FOREIGN KEY ("kitId") REFERENCES "Kit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BomLine" ADD CONSTRAINT "BomLine_componentKitId_fkey" FOREIGN KEY ("componentKitId") REFERENCES "Kit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComponentMeta" ADD CONSTRAINT "ComponentMeta_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessedEvent" ADD CONSTRAINT "ProcessedEvent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLineState" ADD CONSTRAINT "OrderLineState_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleLine" ADD CONSTRAINT "SaleLine_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerBatch" ADD CONSTRAINT "LedgerBatch_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "LedgerBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PoLine" ADD CONSTRAINT "PoLine_poId_fkey" FOREIGN KEY ("poId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostChange" ADD CONSTRAINT "CostChange_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogScan" ADD CONSTRAINT "CatalogScan_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogVariant" ADD CONSTRAINT "CatalogVariant_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

