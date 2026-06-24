-- CreateTable
CREATE TABLE "AgentScriptVersion" (
    "id" SERIAL NOT NULL,
    "agentId" TEXT NOT NULL,
    "script" TEXT NOT NULL,
    "label" TEXT,
    "savedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentScriptVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentScriptVersion_agentId_idx" ON "AgentScriptVersion"("agentId");

-- CreateIndex
CREATE INDEX "AgentScriptVersion_savedAt_idx" ON "AgentScriptVersion"("savedAt");
