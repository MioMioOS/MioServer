ALTER TABLE "control_tasks"
  ADD COLUMN IF NOT EXISTS "creator_instance_id" UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'control_tasks_creator_instance_id_fkey'
  ) THEN
    ALTER TABLE "control_tasks"
      ADD CONSTRAINT "control_tasks_creator_instance_id_fkey"
      FOREIGN KEY ("creator_instance_id")
      REFERENCES "control_agents"("id")
      ON DELETE SET NULL
      ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "control_tasks_creator_instance_id_idx"
  ON "control_tasks"("creator_instance_id");
