-- CLI mode: live runtime stream + owner input queue (both purged after 2 days).

-- CreateTable
CREATE TABLE "control_cli_events" (
    "id" BIGSERIAL NOT NULL,
    "workroom_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "control_cli_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control_cli_inputs" (
    "id" UUID NOT NULL,
    "workroom_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumed_at" TIMESTAMP(3),

    CONSTRAINT "control_cli_inputs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "control_cli_events_channel_id_id_idx" ON "control_cli_events"("channel_id", "id");

-- CreateIndex
CREATE INDEX "control_cli_events_created_at_idx" ON "control_cli_events"("created_at");

-- CreateIndex
CREATE INDEX "control_cli_inputs_agent_id_consumed_at_idx" ON "control_cli_inputs"("agent_id", "consumed_at");

-- CreateIndex
CREATE INDEX "control_cli_inputs_created_at_idx" ON "control_cli_inputs"("created_at");
