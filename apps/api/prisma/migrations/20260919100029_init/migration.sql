-- CreateTable
CREATE TABLE "Simulation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL,
    "simulationTimeMs" INTEGER NOT NULL,
    "speedMultiplier" REAL NOT NULL,
    "queueCapacity" INTEGER NOT NULL,
    "stateVersion" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SchedulerConfig" (
    "simulationId" TEXT NOT NULL PRIMARY KEY,
    "algorithm" TEXT NOT NULL,
    "agingIntervalMs" INTEGER NOT NULL,
    "agingFactor" INTEGER NOT NULL,
    "priorityCap" INTEGER NOT NULL,
    "starvationWarningMs" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL,
    CONSTRAINT "SchedulerConfig_simulationId_fkey" FOREIGN KEY ("simulationId") REFERENCES "Simulation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "simulationId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "documentName" TEXT NOT NULL,
    "pages" INTEGER NOT NULL,
    "pagesCompleted" INTEGER NOT NULL,
    "basePriority" INTEGER NOT NULL,
    "colorMode" TEXT NOT NULL,
    "duplex" BOOLEAN NOT NULL,
    "status" TEXT NOT NULL,
    "submittedAtMs" INTEGER NOT NULL,
    "queuedAtMs" INTEGER NOT NULL,
    "startedAtMs" INTEGER,
    "completedAtMs" INTEGER,
    "assignedPrinterId" TEXT,
    "cancellationRequestedAtMs" INTEGER,
    "lastProgressAtMs" INTEGER,
    "retryCount" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    CONSTRAINT "Job_simulationId_fkey" FOREIGN KEY ("simulationId") REFERENCES "Simulation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Printer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "simulationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "pagesPerMinute" REAL NOT NULL,
    "supportsColor" BOOLEAN NOT NULL,
    "supportsDuplex" BOOLEAN NOT NULL,
    "activeJobId" TEXT,
    "version" INTEGER NOT NULL,
    CONSTRAINT "Printer_simulationId_fkey" FOREIGN KEY ("simulationId") REFERENCES "Simulation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DomainEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "simulationId" TEXT NOT NULL,
    "stateVersion" INTEGER NOT NULL,
    "eventIndex" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "simulationTimeMs" INTEGER NOT NULL,
    "correlationId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DomainEvent_simulationId_fkey" FOREIGN KEY ("simulationId") REFERENCES "Simulation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "simulationId" TEXT NOT NULL,
    "actorKind" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "commandType" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "stateVersionBefore" INTEGER NOT NULL,
    "stateVersionAfter" INTEGER NOT NULL,
    "outcome" TEXT NOT NULL,
    "reasonCode" TEXT,
    "redactedParameters" JSONB NOT NULL,
    "durationMs" REAL NOT NULL,
    "occurredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditEntry_simulationId_fkey" FOREIGN KEY ("simulationId") REFERENCES "Simulation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "simulationId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "routeKey" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "response" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    CONSTRAINT "IdempotencyKey_simulationId_fkey" FOREIGN KEY ("simulationId") REFERENCES "Simulation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Snapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "simulationId" TEXT NOT NULL,
    "stateVersion" INTEGER NOT NULL,
    "state" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Snapshot_simulationId_fkey" FOREIGN KEY ("simulationId") REFERENCES "Simulation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BenchmarkRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "simulationId" TEXT NOT NULL,
    "workloadHash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "request" JSONB NOT NULL,
    "result" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BenchmarkRun_simulationId_fkey" FOREIGN KEY ("simulationId") REFERENCES "Simulation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OutboxEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "simulationId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" DATETIME,
    CONSTRAINT "OutboxEntry_simulationId_fkey" FOREIGN KEY ("simulationId") REFERENCES "Simulation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Job_simulationId_status_submittedAtMs_idx" ON "Job"("simulationId", "status", "submittedAtMs");

-- CreateIndex
CREATE UNIQUE INDEX "Job_simulationId_sequence_key" ON "Job"("simulationId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "Printer_simulationId_name_key" ON "Printer"("simulationId", "name");

-- CreateIndex
CREATE INDEX "DomainEvent_simulationId_createdAt_idx" ON "DomainEvent"("simulationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DomainEvent_simulationId_stateVersion_eventIndex_key" ON "DomainEvent"("simulationId", "stateVersion", "eventIndex");

-- CreateIndex
CREATE INDEX "AuditEntry_simulationId_occurredAt_idx" ON "AuditEntry"("simulationId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditEntry_correlationId_idx" ON "AuditEntry"("correlationId");

-- CreateIndex
CREATE INDEX "IdempotencyKey_expiresAt_idx" ON "IdempotencyKey"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyKey_actorId_routeKey_key_key" ON "IdempotencyKey"("actorId", "routeKey", "key");

-- CreateIndex
CREATE INDEX "Snapshot_simulationId_createdAt_idx" ON "Snapshot"("simulationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Snapshot_simulationId_stateVersion_key" ON "Snapshot"("simulationId", "stateVersion");

-- CreateIndex
CREATE INDEX "BenchmarkRun_simulationId_createdAt_idx" ON "BenchmarkRun"("simulationId", "createdAt");

-- CreateIndex
CREATE INDEX "BenchmarkRun_workloadHash_idx" ON "BenchmarkRun"("workloadHash");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxEntry_eventId_key" ON "OutboxEntry"("eventId");

-- CreateIndex
CREATE INDEX "OutboxEntry_simulationId_deliveredAt_createdAt_idx" ON "OutboxEntry"("simulationId", "deliveredAt", "createdAt");
