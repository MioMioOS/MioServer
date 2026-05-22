/**
 * #156 — empty-JSON-body parser unit tests (no DB).
 *
 * Verifies the ONLY behavior change (empty → {}) and that non-empty parsing is unchanged
 * (valid JSON parses; malformed JSON → 400).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { registerEmptyJsonBodyParser } from './jsonBodyParser';

let app: FastifyInstance;

beforeAll(async () => {
  app = fastify();
  registerEmptyJsonBodyParser(app);
  // Echo the parsed body so we can assert what the parser produced.
  app.post('/echo', async (req) => ({ body: req.body }));
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

const post = (opts: { payload?: string; contentType?: string }) =>
  app.inject({
    method: 'POST',
    url: '/echo',
    headers: opts.contentType ? { 'content-type': opts.contentType } : {},
    ...(opts.payload !== undefined ? { payload: opts.payload } : {}),
  });

describe('#156 empty-JSON-body parser', () => {
  it('empty application/json body → {} (not 400)', async () => {
    const res = await post({ contentType: 'application/json' }); // no payload = empty body
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).body).toEqual({});
  });

  it('whitespace-only body → {}', async () => {
    const res = await post({ contentType: 'application/json', payload: '   ' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).body).toEqual({});
  });

  it('valid JSON body parses unchanged', async () => {
    const res = await post({ contentType: 'application/json', payload: JSON.stringify({ a: 1, b: 'x' }) });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).body).toEqual({ a: 1, b: 'x' });
  });

  it('malformed JSON → 400 (default behavior preserved)', async () => {
    const res = await post({ contentType: 'application/json', payload: '{ not json' });
    expect(res.statusCode).toBe(400);
  });
});
