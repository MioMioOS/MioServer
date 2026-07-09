-- 客户频道 → 关联的内部开发频道(派发默认目标)
ALTER TABLE "control_channels" ADD COLUMN "linked_channel_id" UUID;
