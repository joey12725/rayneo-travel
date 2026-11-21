// Travel HTTP routes (docs/spec.md "Gateway API"): GET /travel, flights, refresh and settings.
// `r` is the host router: r.get/post/put/del(path, handler, opts) where handler({ req, params }) returns a JSON value
// and a thrown error with `status` becomes that HTTP status with body { error: message }.
import { travelView, addFlight, removeFlight, refreshAll, getSettings, saveSettings, createTravelPoller, httpError } from './travel.mjs';

const MAX_BODY = 64 * 1024;
/** Minimal JSON body reader for hosts that do not supply their own (empty body = {}). */
export async function readJson(req) {
  const chunks = []; let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw httpError(413, 'body_too_large');
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch { throw httpError(400, 'invalid_json'); }
}

/**
 * Registers the routes and creates the poller as `ctx.travel` ({tick, start, stop}).
 * opts.readJson: the host's body reader; opts.scope: route options passed through (e.g. token scopes);
 * opts.poll: start the poller now (default ctx.config.travelNotify === true). Run the poller in one process only.
 */
export function register(r, ctx, { readJson: read = readJson, scope, poll = ctx.config?.travelNotify === true } = {}) {
  const o = scope === undefined ? {} : { scope };
  ctx.travel = createTravelPoller(ctx);
  if (poll) ctx.travel.start();
  r.get('/travel', () => travelView(ctx), o);
  r.post('/travel/flights', async ({ req }) => addFlight(ctx, await read(req)), o);
  r.del('/travel/flights/:id', async ({ params }) => { await removeFlight(ctx, params.id); return { ok: true }; }, o);
  r.post('/travel/refresh', () => refreshAll(ctx), o);
  r.get('/travel/settings', () => getSettings(ctx), o);
  r.put('/travel/settings', async ({ req }) => saveSettings(ctx, await read(req)), o);
  return ctx.travel;
}
