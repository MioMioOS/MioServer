-- CLI mode: extras on an owner input (attachment ids for a prompt with files).

-- AlterTable
ALTER TABLE "control_cli_inputs" ADD COLUMN "meta" JSONB;
