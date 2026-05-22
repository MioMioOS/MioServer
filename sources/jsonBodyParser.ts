/**
 * #156 — empty-body-tolerant JSON content-type parser.
 *
 * Fastify's default `application/json` parser rejects an EMPTY body with 400
 * (FST_ERR_CTP_EMPTY_JSON_BODY). Several clients legitimately POST with
 * `Content-Type: application/json` and no body for endpoints that take no input (e.g. the operator
 * pairing redeem, connection access/revoke). Forcing them to send a literal `{}` is needless friction.
 *
 * This parser treats an empty/whitespace-only body as `{}` and otherwise behaves EXACTLY like the
 * default: `JSON.parse`, with a 400 on malformed JSON. It is the ONLY behavior change — non-empty
 * bodies parse identically to before — so it is safe to apply server-wide.
 *
 * Register once, right after the Fastify instance is created (before routes).
 */
import type { FastifyInstance } from 'fastify';

export function registerEmptyJsonBodyParser(app: FastifyInstance): void {
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    // Empty or whitespace-only → treat as an empty object (the #156 fix).
    if (body === undefined || body === null || (typeof body === 'string' && body.trim() === '')) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      // Mirror Fastify's default: malformed JSON → 400.
      (err as Error & { statusCode?: number }).statusCode = 400;
      done(err as Error, undefined);
    }
  });
}
