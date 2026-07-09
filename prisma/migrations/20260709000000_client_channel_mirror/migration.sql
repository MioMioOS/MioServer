-- 客户频道任务桥:内部镜像任务 → 客户需求单的单向回流关联
ALTER TABLE "control_tasks" ADD COLUMN "mirror_of_task_id" UUID;
CREATE INDEX "control_tasks_mirror_of_idx" ON "control_tasks" ("mirror_of_task_id") WHERE "mirror_of_task_id" IS NOT NULL;
