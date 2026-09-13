-- CreateTable
CREATE TABLE "Trip" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "destination" TEXT NOT NULL,
    "earliestStart" TEXT NOT NULL,
    "latestEnd" TEXT NOT NULL,
    "tripDays" INTEGER NOT NULL,
    "organizerId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "candidateOptionsJson" TEXT NOT NULL DEFAULT '[]',
    "liveStateJson" TEXT NOT NULL,
    "selectedPlanId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Trip_selectedPlanId_fkey" FOREIGN KEY ("selectedPlanId") REFERENCES "Plan" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Member" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tripId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "discordId" TEXT,
    "optedOut" BOOLEAN NOT NULL DEFAULT false,
    "responseState" TEXT NOT NULL,
    CONSTRAINT "Member_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Constraint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "memberId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "hardness" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "provenanceJson" TEXT NOT NULL,
    "valueJson" TEXT NOT NULL,
    "recordedAt" DATETIME NOT NULL,
    CONSTRAINT "Constraint_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tripId" TEXT NOT NULL,
    "paidBy" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "planItemId" TEXT,
    "splitAmongJson" TEXT NOT NULL,
    "postedAt" DATETIME NOT NULL,
    CONSTRAINT "LedgerEntry_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tripId" TEXT NOT NULL,
    "memberId" TEXT,
    "channel" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "externalId" TEXT,
    "at" DATETIME NOT NULL,
    CONSTRAINT "Message_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tripId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Plan_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PlanItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "planId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "startsAt" DATETIME NOT NULL,
    "endsAt" DATETIME NOT NULL,
    "costCents" INTEGER NOT NULL,
    "participantsJson" TEXT NOT NULL,
    "bookingRef" TEXT,
    CONSTRAINT "PlanItem_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PlanItemDependency" (
    "itemId" TEXT NOT NULL,
    "dependsOnId" TEXT NOT NULL,

    PRIMARY KEY ("itemId", "dependsOnId"),
    CONSTRAINT "PlanItemDependency_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "PlanItem" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PlanItemDependency_dependsOnId_fkey" FOREIGN KEY ("dependsOnId") REFERENCES "PlanItem" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Market" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tripId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "outcomesJson" TEXT NOT NULL,
    "openingPricesJson" TEXT NOT NULL,
    "currentPricesJson" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "resolutionSourceJson" TEXT NOT NULL,
    "resolvedOutcome" TEXT,
    "generatedFromJson" TEXT NOT NULL,
    "openedAt" DATETIME NOT NULL,
    "closesAt" DATETIME NOT NULL,
    CONSTRAINT "Market_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Position" (
    "marketId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "shares" REAL NOT NULL,
    "avgPrice" REAL NOT NULL,

    PRIMARY KEY ("marketId", "memberId", "outcome"),
    CONSTRAINT "Position_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Position_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ObservedEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tripId" TEXT NOT NULL,
    "at" DATETIME NOT NULL,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "planItemId" TEXT,
    "memberId" TEXT,
    "payloadJson" TEXT NOT NULL,
    CONSTRAINT "ObservedEvent_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Divergence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tripId" TEXT NOT NULL,
    "planItemId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "expectedJson" TEXT NOT NULL,
    "observedJson" TEXT NOT NULL,
    "repairOptionsJson" TEXT NOT NULL,
    "selectedRepairId" TEXT,
    "detectedAt" DATETIME NOT NULL,
    CONSTRAINT "Divergence_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ApprovalToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tripId" TEXT NOT NULL,
    "grantedBy" TEXT NOT NULL,
    "grantedAt" DATETIME NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "scopeJson" TEXT NOT NULL,
    "usedAt" DATETIME,
    CONSTRAINT "ApprovalToken_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ExecutedAction" (
    "idempotencyKey" TEXT NOT NULL PRIMARY KEY,
    "tripId" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "reversibility" TEXT NOT NULL,
    "approvalTokenId" TEXT,
    "status" TEXT NOT NULL,
    "requestJson" TEXT NOT NULL,
    "responseJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "ExecutedAction_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ExecutedAction_approvalTokenId_fkey" FOREIGN KEY ("approvalTokenId") REFERENCES "ApprovalToken" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TraceSpan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "traceId" TEXT NOT NULL,
    "parentId" TEXT,
    "step" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL,
    "endedAt" DATETIME NOT NULL,
    "latencyMs" REAL NOT NULL,
    "status" TEXT NOT NULL,
    "inputJson" TEXT NOT NULL,
    "outputJson" TEXT,
    "errorJson" TEXT,
    "retriesJson" TEXT NOT NULL,
    "llmCallsJson" TEXT NOT NULL,
    "idempotencyKey" TEXT
);

-- CreateIndex
CREATE UNIQUE INDEX "Trip_selectedPlanId_key" ON "Trip"("selectedPlanId");

-- CreateIndex
CREATE UNIQUE INDEX "Member_tripId_phone_key" ON "Member"("tripId", "phone");

-- CreateIndex
CREATE INDEX "Constraint_memberId_source_idx" ON "Constraint"("memberId", "source");

-- CreateIndex
CREATE UNIQUE INDEX "Message_externalId_key" ON "Message"("externalId");

-- CreateIndex
CREATE INDEX "Message_tripId_memberId_at_idx" ON "Message"("tripId", "memberId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "Plan_tripId_version_key" ON "Plan"("tripId", "version");

-- CreateIndex
CREATE INDEX "ObservedEvent_tripId_at_idx" ON "ObservedEvent"("tripId", "at");

-- CreateIndex
CREATE INDEX "TraceSpan_traceId_startedAt_idx" ON "TraceSpan"("traceId", "startedAt");
