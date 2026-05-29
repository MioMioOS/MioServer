Slice 7 — user auth unification. See spec at
/Users/ying/Documents/AI/CodeLight/docs/superpowers/specs/2026-05-26-slock-clone-slice7-user-auth-unification-design.md
(§4 schema changes, §7 migration plan). Plan: /Users/ying/Documents/AI/CodeLight/docs/superpowers/plans/2026-05-26-slock-clone-slice7-user-auth-unification-plan.md (Chunk A / Task A1).

## Cross-env guard on `devices.user_id` — DO NOT STRIP

The `ALTER TABLE IF EXISTS devices ...` plus the `DO $$ ... $$` index block
are intentional, not defensive paranoia:

- `scripts/setup-test-db.sh` applies ONLY the control-plane migration chain
  (see header comment in that file). The `devices` table belongs to the
  chat-side app migration chain, which is never replayed against the test DB.
- Without the `IF EXISTS` guard, this migration would fail in CI / integration
  tests with `relation "devices" does not exist`.
- Splitting the file (one for control-plane, one chat-side) would violate the
  spec's "one migration" constraint and the existing test harness model.

So: the guards are the only way to keep "one migration file" AND "test harness
without chat-side tables" both working. In prod (`prisma deploy` against the
full chain) `devices` exists and the column + FK (`ON DELETE SET NULL`, per
spec §5.4) + index are created normally. The NOTICE about the skipped relation
in test-DB output is expected — do not "fix" it by removing the guards.
