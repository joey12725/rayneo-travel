// Travel HTTP routes (routes.mjs) over a fake router: add/duplicate/delete/refresh/settings, errors, the default zone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeStore, fakeEvents, fakeRouter } from './fakes.mjs';
import { register } from '../routes.mjs';
import { AEROAPI_KEY, parseIdent, setHttpError, TravelError } from '../travel.mjs';

const NOW = Date.parse('2030-01-15T03:00:00Z'); // still Jan 14 in New York, already Jan 15 in UTC
const at = (t) => new Date(t).toISOString().replace('.000Z', 'Z');
const ORD = { code_iata: 'ORD', timezone: 'America/Chicago', city: 'Chicago', name: "O'Hare Intl" };
const LGA = { code_iata: 'LGA', timezone: 'America/New_York', city: 'New York', name: 'LaGuardia' };
const row = (out) => ({ ident: 'XXX123', ident_iata: 'XX123', fa_flight_id: `XXX123-${out}`, operator_iata: 'XX', flight_number: '123',
  origin: ORD, destination: LGA, scheduled_out: at(out), estimated_out: at(out), scheduled_in: at(out + 2 * 3600000), estimated_in: at(out + 2 * 3600000), gate_origin: 'B7' });

function setup({ key = 'k-123', config } = {}) {
  const calls = [];
  const store = fakeStore();
  const ctx = { now: () => NOW, store, config, log: () => {},
    fetch: async (url) => { calls.push(String(url)); return Response.json({ flights: [row(Date.parse('2030-01-15T15:00:00Z'))] }); },
    secret: async (name) => (name === AEROAPI_KEY ? key : null) };
  ctx.events = fakeEvents(store, { now: () => NOW });
  const r = fakeRouter();
  const poller = register(r, ctx, { scope: ['phone'] });
  return { r, ctx, calls, poller };
}

test('routes: add (date defaults to today in the configured zone), duplicate, list, refresh, settings, delete', async () => {
  const { r, calls, poller } = setup();
  assert.equal(typeof poller.tick, 'function');
  assert.ok(r.routes.every(x => x.opts.scope[0] === 'phone'), 'route options pass through');
  assert.deepEqual((await r.call('POST', '/travel/flights', { ident: '123' })), { status: 400, value: { error: 'airline_required' } });
  assert.equal((await r.call('POST', '/travel/flights', { ident: 'XX123', date: '2030-02-30' })).status, 400);
  assert.deepEqual(await r.call('POST', '/travel/flights', '{nope'), { status: 400, value: { error: 'invalid_json' } });
  const add = await r.call('POST', '/travel/flights', { ident: 'xx 123' });
  assert.equal(add.status, 200); assert.equal(add.value.id, 'XX123-2030-01-15', 'no config: today in UTC');
  assert.equal(add.value.status, 'scheduled'); assert.equal(add.value.departure.gate, 'B7');
  const n = calls.length;
  assert.equal((await r.call('POST', '/travel/flights', { ident: 'XX123', date: '2030-01-15' })).value.id, add.value.id);
  assert.equal(calls.length, n, 'a duplicate returns the existing flight without polling');
  const list = (await r.call('GET', '/travel')).value;
  assert.deepEqual(Object.keys(list).sort(), ['connections', 'flights', 'provider', 'settings', 'updatedAt']);
  assert.deepEqual(list.provider, { name: 'aeroapi', configured: true });
  assert.equal((await r.call('POST', '/travel/refresh')).value.flights[0].polledAt, new Date(NOW).toISOString());
  assert.ok(calls.length > n);
  assert.equal((await r.call('PUT', '/travel/settings', { minConnectMin: 45 })).value.minConnectMin, 45);
  assert.equal((await r.call('PUT', '/travel/settings', { minConnectMin: -1 })).status, 400);
  assert.equal((await r.call('GET', '/travel/settings')).value.minConnectMin, 45);
  assert.deepEqual(await r.call('DELETE', '/travel/flights/XX123-2030-01-15'), { status: 200, value: { ok: true } });
  assert.equal((await r.call('GET', '/travel')).value.flights.length, 0);
});

test('the home zone comes from ctx.config.tz', async () => {
  const { r } = setup({ config: { tz: 'America/New_York' } });
  assert.equal((await r.call('POST', '/travel/flights', { ident: 'XX123' })).value.id, 'XX123-2030-01-14');
});

test('no key: flights are listed with no_provider and nothing is fetched', async () => {
  const { r, calls } = setup({ key: null });
  const add = await r.call('POST', '/travel/flights', { ident: 'XX123', date: '2030-01-15' });
  assert.equal(add.value.error, 'no_provider'); assert.equal(add.value.statusText, 'No flight data provider');
  assert.equal((await r.call('GET', '/travel')).value.provider.configured, false);
  assert.equal(calls.length, 0);
});

test('a host can register its own HTTP error class', () => {
  class HostError extends Error { constructor(status, message) { super(message); this.status = status; } }
  setHttpError(HostError);
  try { assert.throws(() => parseIdent('123'), (e) => e instanceof HostError && e.status === 400); }
  finally { setHttpError(null); }
  assert.throws(() => parseIdent('123'), (e) => e instanceof TravelError);
});
