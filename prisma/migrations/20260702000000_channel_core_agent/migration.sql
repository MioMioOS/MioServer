-- Elected core agent per channel (answers messages that @-mention nobody).
ALTER TABLE "control_channels" ADD COLUMN "core_agent_id" UUID;
