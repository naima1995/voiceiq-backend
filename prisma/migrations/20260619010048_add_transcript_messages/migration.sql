-- CreateTable
CREATE TABLE "TranscriptMessage" (
    "id" SERIAL NOT NULL,
    "callId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TranscriptMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TranscriptMessage_callId_idx" ON "TranscriptMessage"("callId");

-- CreateIndex
CREATE INDEX "TranscriptMessage_ts_idx" ON "TranscriptMessage"("ts");
