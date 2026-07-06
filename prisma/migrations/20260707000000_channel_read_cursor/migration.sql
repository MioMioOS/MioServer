CREATE TABLE "control_channel_reads" (
  "channel_id" UUID NOT NULL,
  "user_id" TEXT NOT NULL,
  "last_read_seq" BIGINT NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "control_channel_reads_pkey" PRIMARY KEY ("channel_id", "user_id")
);
