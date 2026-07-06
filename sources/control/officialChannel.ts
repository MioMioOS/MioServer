/**
 * The OFFICIAL channel — one global announcements/feedback channel visible to
 * every user in every workspace.
 *
 * Mechanism: a dedicated system workroom ("Mio 官方") holding exactly one
 * public channel ("官方"). Every user is auto-enrolled as a member of that
 * workroom (backfilled once via SQL; kept current by an upsert on /v1/users/me,
 * so any newly registered/invited user joins on first session load). Because
 * membership is REAL, every existing guard/WS/unread code path works untouched
 * — no auth bypasses. The channel is public, so workroom membership alone
 * grants read + post (anyone can leave feedback; announcements come from the
 * workroom owner).
 *
 * Fixed, human-recognizable UUIDs — created by ops SQL on 2026-07-05.
 */
export const OFFICIAL_WORKROOM_ID = '00000000-0000-4000-8000-00000000f0f0';
export const OFFICIAL_CHANNEL_ID = '00000000-0000-4000-8000-00000000c0c0';

/** Messages from this user in the official channel are presented as the
 *  product voice "MioMio" (announcements), not a personal account. */
export const OFFICIAL_ANNOUNCER_USER_ID = 'cmpmtksgg0000wklz9tlxh0rn';
export const OFFICIAL_ANNOUNCER_NAME = 'MioMio';
