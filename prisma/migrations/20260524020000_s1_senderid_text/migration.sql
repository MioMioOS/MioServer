-- Migration: S1 senderId TEXT (C1 fix — pairing: subject support)
-- Branch: feat/server-control-plane
--
-- Changes control_messages.sender_id from UUID to TEXT so that the op_sess_
-- operator path (which uses operatorSubjectId = 'pairing:<uuid>') can write
-- messages without a Postgres "invalid input syntax for type uuid" error.
--
-- This matches the opaque-actor-id pattern already used by ControlChannel.created_by
-- and ControlChannelMember.member_id (both TEXT, not UUID).

ALTER TABLE control_messages
  ALTER COLUMN sender_id TYPE TEXT USING sender_id::text;
