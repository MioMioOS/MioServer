-- Migration: Control Plane Core Objects
-- Source: erd-api-contract.md v3 (4d5d06e6) + daemon-design v4 (9be731c9)
-- Branch: feat/server-control-plane
--
-- All new tables are prefixed control_ to coexist with existing legacy tables.
-- API layer maps to clean client-facing names (no Control* prefix exposed).

-- ============================================================
-- 1. ORGS
-- ============================================================
CREATE TABLE control_orgs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  owner_user_id UUID NOT NULL,
  billing_plan  TEXT NOT NULL DEFAULT 'free',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 2. CREDENTIALS (secret aliases; content in vault, never here)
-- ============================================================
CREATE TABLE control_credentials (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES control_orgs(id),
  alias        TEXT NOT NULL,
  kind         TEXT NOT NULL, -- asc_api_key | vercel_token | ssh_key | cert | env_group | other
  scope        TEXT,
  storage_ref  TEXT NOT NULL,  -- vault pointer; never plain secret
  created_by   UUID NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);

-- ============================================================
-- 3. MACHINES (daemon registration; token_hash = SHA-256, not plaintext)
-- ============================================================
CREATE TABLE control_machines (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(), -- permanent UUID4
  org_id           UUID REFERENCES control_orgs(id),
  display_name     TEXT,
  platform         TEXT NOT NULL DEFAULT 'darwin',
  arch             TEXT NOT NULL DEFAULT 'arm64',
  token_hash       TEXT NOT NULL,  -- SHA-256(machine_token); actual token in Keychain on Mac
  token_expires_at TIMESTAMPTZ NOT NULL,
  bound_at         TIMESTAMPTZ,
  last_seen_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 4. AGENTS
-- ============================================================
CREATE TABLE control_agents (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES control_orgs(id),
  name         TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role         TEXT NOT NULL,  -- ops | pm | engineer | designer | researcher | other
  description  TEXT NOT NULL DEFAULT '',
  capabilities JSONB NOT NULL DEFAULT '{}',
  runtime      TEXT,           -- claude | codex | opencode | kimi | other
  machine_id   TEXT,
  status       TEXT NOT NULL DEFAULT 'offline', -- online | offline | busy | drain
  permissions  JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_control_agents_org_status ON control_agents(org_id, status);

-- ============================================================
-- 5. WORKROOMS (current_goal_id: nullable UUID, FK added after goals)
-- ============================================================
CREATE TABLE control_workrooms (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES control_orgs(id),
  name            TEXT NOT NULL,
  description     TEXT,
  visibility      TEXT NOT NULL DEFAULT 'private', -- public | private
  purpose         TEXT,
  current_goal_id UUID,   -- FK added after goals table exists
  created_by      UUID NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at     TIMESTAMPTZ
);

-- ============================================================
-- 6. GOALS (FK to workrooms; workrooms.current_goal_id FK added below)
-- ============================================================
CREATE TABLE control_goals (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workroom_id           UUID NOT NULL REFERENCES control_workrooms(id),
  source_message_id     UUID,   -- FK added after messages table exists
  title                 TEXT NOT NULL,
  description           TEXT NOT NULL DEFAULT '',
  success_criteria      TEXT NOT NULL DEFAULT '',
  status                TEXT NOT NULL DEFAULT 'active',
  -- active | paused | in_review | achieved | canceled
  owner_user_id         UUID NOT NULL,
  current_task_ids      UUID[] NOT NULL DEFAULT '{}',
  accepted_artifact_ids UUID[] NOT NULL DEFAULT '{}',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_control_goals_workroom ON control_goals(workroom_id);

-- Add deferred FK from workrooms to goals (breaks circular dep)
ALTER TABLE control_workrooms
  ADD CONSTRAINT fk_workroom_current_goal
  FOREIGN KEY (current_goal_id) REFERENCES control_goals(id)
  DEFERRABLE INITIALLY DEFERRED;

-- ============================================================
-- 7. MESSAGES
-- ============================================================
CREATE TABLE control_messages (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workroom_id         UUID NOT NULL REFERENCES control_workrooms(id),
  sender_kind         TEXT NOT NULL, -- user | agent | system
  sender_id           UUID NOT NULL,
  content             TEXT NOT NULL,
  mentions            UUID[] NOT NULL DEFAULT '{}',
  hash_refs           JSONB NOT NULL DEFAULT '{}',
  attachment_ids      UUID[] NOT NULL DEFAULT '{}',
  embedded_card_type  TEXT,  -- session | task | artifact | approval | handoff | system_event
  embedded_card_id    UUID,
  thread_reply_count  INT NOT NULL DEFAULT 0,
  last_thread_reply_at TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_control_messages_workroom_created
  ON control_messages(workroom_id, created_at DESC);

-- Now we can add source_message FK to goals
ALTER TABLE control_goals
  ADD CONSTRAINT fk_goal_source_message
  FOREIGN KEY (source_message_id) REFERENCES control_messages(id)
  DEFERRABLE INITIALLY DEFERRED;

-- ============================================================
-- 8. ATTACHMENTS
-- ============================================================
CREATE TABLE control_attachments (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workroom_id           UUID NOT NULL REFERENCES control_workrooms(id),
  message_id            UUID REFERENCES control_messages(id),
  thread_reply_id       UUID,  -- FK added after thread_replies (future)
  uploader_kind         TEXT NOT NULL, -- user | agent | daemon
  uploader_id           UUID NOT NULL,
  filename              TEXT NOT NULL,
  mime_type             TEXT NOT NULL,
  size_bytes            BIGINT NOT NULL,
  preview_metadata      JSONB,  -- null when sensitivity=secret or needs_review
  sensitivity           TEXT NOT NULL DEFAULT 'normal', -- normal | secret
  classification_source TEXT NOT NULL DEFAULT 'uploader',
  policy_result         TEXT NOT NULL DEFAULT 'allowed',
  -- allowed | alias_only | blocked | needs_review
  storage_key           TEXT,  -- null for blocked
  credential_alias_ref  TEXT,
  permission_scope      TEXT NOT NULL DEFAULT 'members',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_control_attachments_workroom ON control_attachments(workroom_id);
CREATE INDEX idx_control_attachments_message ON control_attachments(message_id);

-- ============================================================
-- 9. THREADS (one per parent message; UNIQUE constraint)
-- ============================================================
CREATE TABLE control_threads (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_message_id UUID NOT NULL UNIQUE REFERENCES control_messages(id),
  workroom_id      UUID NOT NULL REFERENCES control_workrooms(id),
  reply_count      INT NOT NULL DEFAULT 0,
  last_reply_at    TIMESTAMPTZ
);

CREATE INDEX idx_control_threads_workroom ON control_threads(workroom_id);

-- ============================================================
-- 10. SESSIONS
-- ============================================================
CREATE TABLE control_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL,  -- no FK constraint (cross-table reference)
  workroom_id     UUID NOT NULL REFERENCES control_workrooms(id),
  machine_id      UUID REFERENCES control_machines(id),
  mode            TEXT NOT NULL,  -- cmux | daemon | applescript
  runtime         TEXT NOT NULL,  -- claude | codex | opencode | kimi | other
  display_name    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'idle',
  -- idle | running | waiting_for_user | blocked | completed | failed | disconnected | reconnecting
  current_task_id UUID,  -- UI cache only; Task is source of truth
  capabilities    JSONB NOT NULL DEFAULT '{}',
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_control_sessions_workroom_status ON control_sessions(workroom_id, status);
CREATE INDEX idx_control_sessions_machine ON control_sessions(machine_id);

-- ============================================================
-- 11. TASKS (CAS claim on owner_instance_id)
-- ============================================================
CREATE TABLE control_tasks (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workroom_id      UUID NOT NULL REFERENCES control_workrooms(id),
  goal_id          UUID REFERENCES control_goals(id),
  source_message_id UUID REFERENCES control_messages(id),
  title            TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  owner_role       TEXT,
  owner_instance_id UUID REFERENCES control_agents(id),  -- CAS claim target
  status           TEXT NOT NULL DEFAULT 'todo',
  -- todo | in_progress | waiting_approval | in_review | done | canceled
  linked_session_ids UUID[] NOT NULL DEFAULT '{}',
  thread_id        UUID REFERENCES control_threads(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_control_tasks_workroom_status ON control_tasks(workroom_id, status);
CREATE INDEX idx_control_tasks_owner ON control_tasks(owner_instance_id);

-- ============================================================
-- 12. APPROVALS (approval_id referenced by actions — created before actions for FK order)
-- ============================================================
CREATE TABLE control_approvals (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workroom_id      UUID NOT NULL REFERENCES control_workrooms(id),
  session_id       UUID REFERENCES control_sessions(id),
  task_id          UUID REFERENCES control_tasks(id),
  action_id        UUID,  -- FK added after actions table (circular)
  artifact_id      UUID,  -- FK added after artifacts table (circular)
  kind             TEXT NOT NULL, -- pre_action | disposal | artifact_review
  status           TEXT NOT NULL DEFAULT 'pending',
  -- pending | approved | consumed | rejected | snoozed | expired | ignored | rolled_forward | accepted | changes_requested | remediation_created
  reviewer_user_id UUID,
  risk_summary     TEXT NOT NULL DEFAULT '',
  evidence_summary TEXT NOT NULL DEFAULT '',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at       TIMESTAMPTZ,
  decided_at       TIMESTAMPTZ
);

CREATE INDEX idx_control_approvals_workroom_status ON control_approvals(workroom_id, status);

-- ============================================================
-- 13. ACTIONS
-- ============================================================
CREATE TABLE control_actions (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id               UUID NOT NULL REFERENCES control_sessions(id),
  workroom_id              UUID NOT NULL REFERENCES control_workrooms(id),
  task_id                  UUID REFERENCES control_tasks(id),
  actor_agent_id           UUID NOT NULL REFERENCES control_agents(id),
  kind                     TEXT NOT NULL,
  summary                  TEXT NOT NULL,
  reversibility            TEXT NOT NULL,
  -- reversible | irreversible_abortable | irreversible_no_abort
  risk_level               TEXT NOT NULL, -- low | medium | high | critical
  status                   TEXT NOT NULL DEFAULT 'proposed',
  -- proposed | approved | rejected | canceled | fired | transmission_complete | reconciling | succeeded | failed | needs_human
  transmission_completed_at TIMESTAMPTZ,
  external_confirmed_at    TIMESTAMPTZ,
  requires_approval        BOOLEAN NOT NULL DEFAULT FALSE,
  approval_id              UUID REFERENCES control_approvals(id),  -- set at fire
  approved_at_snapshot     TIMESTAMPTZ,
  credential_alias_ref     TEXT,
  client_idempotency_key   TEXT NOT NULL UNIQUE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fired_at                 TIMESTAMPTZ,

  -- INVARIANT: irreversible_no_abort => requires_approval = true
  CONSTRAINT chk_irreversible_requires_approval
    CHECK (reversibility != 'irreversible_no_abort' OR requires_approval = TRUE)
);

CREATE INDEX idx_control_actions_workroom_status ON control_actions(workroom_id, status);
CREATE INDEX idx_control_actions_session ON control_actions(session_id);

-- Now we can add the circular FK from approvals.action_id to actions
ALTER TABLE control_approvals
  ADD CONSTRAINT fk_approval_action
  FOREIGN KEY (action_id) REFERENCES control_actions(id);

-- ============================================================
-- 14. ACTION_APPROVAL_CONSUMPTIONS
-- Both UNIQUE constraints are the core safety invariant:
--   approval_id UNIQUE → one approval cannot fund two fires
--   action_id UNIQUE   → one action cannot consume two approvals
-- Fire transaction: BEGIN → SELECT FOR UPDATE approval → INSERT here → UPDATE status → COMMIT
-- ============================================================
CREATE TABLE control_action_approval_consumptions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id UUID NOT NULL UNIQUE REFERENCES control_approvals(id),
  action_id   UUID NOT NULL UNIQUE REFERENCES control_actions(id),
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 15. ARTIFACTS (three-state milestones: verified_at / external_confirmed_at / human_acked_at)
-- ============================================================
CREATE TABLE control_artifacts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID NOT NULL REFERENCES control_orgs(id),
  workroom_id           UUID NOT NULL REFERENCES control_workrooms(id),
  task_id               UUID REFERENCES control_tasks(id),
  session_id            UUID REFERENCES control_sessions(id),
  action_id             UUID REFERENCES control_actions(id),
  scope_type            TEXT NOT NULL, -- org | workroom | task | session | action
  type                  TEXT NOT NULL,
  -- prd | design | code_path | build | deployment_url | ipa_upload | test_report | runbook | log | screenshot
  title                 TEXT NOT NULL,
  summary               TEXT NOT NULL DEFAULT '',
  url                   TEXT,
  local_path            TEXT,
  hash                  TEXT,
  external_id           TEXT,
  status                TEXT NOT NULL DEFAULT 'created',
  -- created | verified | external_confirmed | accepted | superseded | rejected | expired | disposed | ignored | rolled_forward
  verified_at           TIMESTAMPTZ,            -- milestone 1: agent verified
  external_confirmed_at TIMESTAMPTZ,            -- milestone 2: external system confirmed (NOT altool Delivery UUID)
  human_acked_at        TIMESTAMPTZ,            -- milestone 3: human accepted in UI
  disposal_status       TEXT NOT NULL DEFAULT 'none',
  -- none | expired | ignored | rolled_forward | remediation_created
  current_pointer_key   TEXT,
  created_by_agent_id   UUID REFERENCES control_agents(id),
  client_idempotency_key TEXT NOT NULL UNIQUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_control_artifacts_workroom_type ON control_artifacts(workroom_id, type);
CREATE INDEX idx_control_artifacts_session ON control_artifacts(session_id);

-- Now add circular FK from approvals.artifact_id to artifacts
ALTER TABLE control_approvals
  ADD CONSTRAINT fk_approval_artifact
  FOREIGN KEY (artifact_id) REFERENCES control_artifacts(id);

-- ============================================================
-- 16. ARTIFACT POINTERS (UNIQUE per workroom key — "current_prd", etc.)
-- ============================================================
CREATE TABLE control_artifact_pointers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workroom_id UUID NOT NULL REFERENCES control_workrooms(id),
  key         TEXT NOT NULL,
  artifact_id UUID NOT NULL REFERENCES control_artifacts(id),
  updated_by  UUID NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (workroom_id, key)
);

-- ============================================================
-- 17. ARTIFACT VERIFICATION LOGS
-- ============================================================
CREATE TABLE control_artifact_verification_logs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id           UUID NOT NULL REFERENCES control_artifacts(id),
  verifier_agent_id     UUID NOT NULL REFERENCES control_agents(id),
  method                TEXT NOT NULL,
  -- curl | hash_compare | app_store_check | browser_check | codesign_verify | ipa_inspect | manual
  status                TEXT NOT NULL, -- passed | failed | inconclusive
  evidence              JSONB NOT NULL DEFAULT '{}',
  error                 TEXT,
  client_idempotency_key TEXT NOT NULL UNIQUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_control_avl_artifact ON control_artifact_verification_logs(artifact_id);

-- ============================================================
-- 18. WORKING AGREEMENTS
-- ============================================================
CREATE TABLE control_working_agreements (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workroom_id           UUID NOT NULL REFERENCES control_workrooms(id),
  participants          UUID[] NOT NULL DEFAULT '{}',
  summary               TEXT NOT NULL,
  rules                 JSONB NOT NULL DEFAULT '[]',
  created_from_message_id UUID REFERENCES control_messages(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_control_working_agreements_workroom ON control_working_agreements(workroom_id);

-- ============================================================
-- 19. HANDOFFS
-- ============================================================
CREATE TABLE control_handoffs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workroom_id           UUID NOT NULL REFERENCES control_workrooms(id),
  from_actor_kind       TEXT NOT NULL, -- user | agent
  from_actor_id         UUID NOT NULL,
  to_role               TEXT NOT NULL,
  to_instance_id        UUID REFERENCES control_agents(id),
  task_id               UUID REFERENCES control_tasks(id),
  input_artifact_ids    UUID[] NOT NULL DEFAULT '{}',
  expected_output       TEXT NOT NULL DEFAULT '',
  acceptance_criteria   TEXT NOT NULL DEFAULT '',
  status                TEXT NOT NULL DEFAULT 'proposed',
  -- proposed | accepted | declined | completed | canceled
  created_from_message_id UUID REFERENCES control_messages(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_control_handoffs_workroom_status ON control_handoffs(workroom_id, status);

-- ============================================================
-- 20. WORKROOM SUMMARIES
-- ============================================================
CREATE TABLE control_workroom_summaries (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workroom_id           UUID NOT NULL REFERENCES control_workrooms(id),
  goal_id               UUID REFERENCES control_goals(id),
  headline              TEXT NOT NULL,
  current_phase         TEXT NOT NULL DEFAULT '',
  active_owner_summary  JSONB NOT NULL DEFAULT '{}',
  needs_attention_count INT NOT NULL DEFAULT 0,
  latest_artifact_ids   UUID[] NOT NULL DEFAULT '{}',
  blocked_items         JSONB NOT NULL DEFAULT '[]',
  next_recommended_action TEXT NOT NULL DEFAULT '',
  generated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_control_workroom_summaries_workroom_gen
  ON control_workroom_summaries(workroom_id, generated_at DESC);

-- ============================================================
-- 21. ROLE INSIGHTS
-- ============================================================
CREATE TABLE control_role_insights (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workroom_id         UUID NOT NULL REFERENCES control_workrooms(id),
  agent_id            UUID NOT NULL REFERENCES control_agents(id),
  related_message_id  UUID REFERENCES control_messages(id),
  related_object_type TEXT,
  related_object_id   UUID,
  reason              TEXT NOT NULL,
  content             TEXT NOT NULL,
  suggested_action    JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_control_role_insights_workroom_created
  ON control_role_insights(workroom_id, created_at DESC);

-- ============================================================
-- 22. ROUTER DECISIONS
-- ============================================================
CREATE TABLE control_router_decisions (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workroom_id               UUID NOT NULL REFERENCES control_workrooms(id),
  trigger_message_id        UUID REFERENCES control_messages(id),
  target_agent_ids          UUID[] NOT NULL DEFAULT '{}',
  reason                    TEXT NOT NULL,
  confidence                FLOAT NOT NULL,
  trigger_type              TEXT NOT NULL,
  -- explicit_mention | role_capability | artifact_type | task_owner | missing_perspective
  related_object_ids        JSONB NOT NULL DEFAULT '{}',
  context_selection_log     JSONB NOT NULL DEFAULT '{}',
  requires_human_confirmation BOOLEAN NOT NULL DEFAULT FALSE,
  create_task               BOOLEAN NOT NULL DEFAULT FALSE,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_control_router_decisions_workroom_created
  ON control_router_decisions(workroom_id, created_at DESC);

-- ============================================================
-- 23. EVENT LOGS (write-before-broadcast; monotonic seq per workroom)
-- Retention: must cover max_catch_up_events (500 rows per workroom).
-- Pruning: check MIN(apply_seq) across client_cursors before deleting.
-- ============================================================
CREATE TABLE control_event_logs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workroom_id  UUID NOT NULL REFERENCES control_workrooms(id),
  seq          BIGINT NOT NULL,
  event_id     UUID NOT NULL UNIQUE,   -- stable dedup key across retries
  topic        TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (workroom_id, seq)
);

CREATE INDEX idx_control_event_logs_workroom_seq
  ON control_event_logs(workroom_id, seq);

-- ============================================================
-- 24. CLIENT CURSORS (per-device × per-scope event position)
-- apply_seq: highest seq received and applied (drives catch-up)
-- read_seq:  highest seq human has visibly read (drives unread badge)
-- ============================================================
CREATE TABLE control_client_cursors (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL,
  device_id   TEXT NOT NULL,
  scope_type  TEXT NOT NULL,  -- workroom | thread | session
  scope_id    UUID NOT NULL,
  topic_group TEXT NOT NULL DEFAULT 'all',  -- messages | tasks | events | all
  apply_seq   BIGINT NOT NULL DEFAULT 0,
  read_seq    BIGINT NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (user_id, device_id, scope_type, scope_id, topic_group)
);

CREATE INDEX idx_control_client_cursors_user_device
  ON control_client_cursors(user_id, device_id);
