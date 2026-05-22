-- #86: operator_session write credential (op_sess_ class), separate from dev_ctl_ (read-only).
-- Root/owner-only CLI mint; only token_hash (sha256) stored, never the raw token.
-- Anti-replay signing-key material is intentionally NOT here — that is the #87 decision.
CREATE TABLE "control_operator_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "token_hash" TEXT NOT NULL,
    "org_id" UUID NOT NULL,
    "workroom_id" UUID NOT NULL,
    "allowed_commands" TEXT[] NOT NULL,
    "operator_subject_id" TEXT NOT NULL,
    "issued_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "expires_at" TIMESTAMPTZ NOT NULL,
    "revoked_at" TIMESTAMPTZ,
    CONSTRAINT "control_operator_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "control_operator_sessions_token_hash_key" ON "control_operator_sessions"("token_hash");
CREATE INDEX "control_operator_sessions_workroom_id_idx" ON "control_operator_sessions"("workroom_id");
