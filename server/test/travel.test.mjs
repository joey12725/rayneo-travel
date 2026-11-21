// Travel engine (docs/spec.md): AeroAPI adapter, flight picking, status mapping, adaptive polling, connections,
// the notification rubric and persistence. Runs with `node --test server/`; no dependencies, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeStore, fakeEvents } from './fakes.mjs';
import {
  boardingOf, boardingLead, BOARDING_LEAD_MIN, connectionStatus, removeFlight, parseIdent, pickFlight, statusOf, statusText, snapshot, nextPollAt, connections, pollFlight, addFlight, travelView,
  createTravelPoller, saveSettings, getSettings, refreshAll, AEROAPI_KEY, TRAVEL_FLIGHTS, DEFAULT_SETTINGS, TravelError,
} from '../travel.mjs';

const MIN = 60000, H = 3600000;
const NOW = Date.parse('2030-01-15T14:00:00Z'); // 8:00 AM in Dallas, 3 h 25 min before XX123 departs
const KEY = 'test-aeroapi-key';
const at = (t) => new Date(t).toISOString().replace('.000Z', 'Z');

// Shaped like a real AeroAPI v4 GET /flights/{ident} row (fields the gateway ignores included).
const DAL = { code: 'KDAL', code_icao: 'KDAL', code_iata: 'DAL', code_lid: 'DAL', timezone: 'America/Chicago', name: 'Dallas Love Field', city: 'Dallas', airport_info_url: '/airports/KDAL' };
const HOU = { code: 'KHOU', code_icao: 'KHOU', code_iata: 'HOU', code_lid: 'HOU', timezone: 'America/Chicago', name: 'William P Hobby', city: 'Houston', airport_info_url: '/airports/KHOU' };
const MSY = { code: 'KMSY', code_icao: 'KMSY', code_iata: 'MSY', code_lid: 'MSY', timezone: 'America/Chicago', name: 'Louis Armstrong New Orleans Intl', city: 'New Orleans', airport_info_url: '/airports/KMSY' };
function aero({ ident = 'XXX123', iata = 'XX123', number = '123', origin = DAL, destination = HOU, out = '2030-01-15T17:25:00Z', block = 65 * MIN, delay = 0, ...o } = {}) {
  const sOut = Date.parse(out), sIn = sOut + block;
  return {
    ident, ident_icao: ident, ident_iata: iata, actual_runway_off: null, actual_runway_on: null,
    fa_flight_id: `${ident}-${Math.floor(sOut / 1000) - 86400}-schedule-0412`, operator: ident.slice(0, 3), operator_icao: ident.slice(0, 3), operator_iata: iata.slice(0, 2),
    flight_number: number, registration: 'N00000', atc_ident: null, inbound_fa_flight_id: 'XXX789-1900000000-schedule-0101',
    codeshares: [], codeshares_iata: [], blocked: false, diverted: false, cancelled: false, position_only: false,
    origin, destination, departure_delay: delay * 60, arrival_delay: delay * 60, filed_ete: 3300, foresight_predictions_available: false,
    scheduled_out: at(sOut), estimated_out: at(sOut + delay * MIN), actual_out: null,
    scheduled_off: at(sOut + 10 * MIN), estimated_off: at(sOut + 10 * MIN + delay * MIN), actual_off: null,
    scheduled_on: at(sIn - 5 * MIN), estimated_on: at(sIn - 5 * MIN + delay * MIN), actual_on: null,
    scheduled_in: at(sIn), estimated_in: at(sIn + delay * MIN), actual_in: null,
    progress_percent: 0, status: delay >= 15 ? 'Scheduled / Delayed' : 'Scheduled', aircraft_type: 'B38M', route_distance: 239,
    filed_airspeed: 404, filed_altitude: null, route: null, baggage_claim: null, seats_cabin_business: null, seats_cabin_coach: 175,
    seats_cabin_first: null, gate_origin: '7', gate_destination: '12', terminal_origin: null, terminal_destination: null, type: 'Airline',
    ...o,
  };
}
const INBOUND = aero({ ident: 'XXX789', iata: 'XX789', number: '789', origin: HOU, destination: DAL, out: '2030-01-15T12:30:00Z', delay: 30, fa_flight_id: 'XXX789-1900000000-schedule-0101',
  actual_out: '2030-01-15T13:02:00Z', actual_off: '2030-01-15T13:12:00Z', progress_percent: 61, status: 'En Route / Delayed' });

/** Fake AeroAPI: `byIdent[ident]` is the flight list (functions are re-evaluated per call), `status` forces errors. */
function fakeAero() {
  const calls = [], api = { byIdent: {}, byId: { [INBOUND.fa_flight_id]: INBOUND }, status: null };
  api.fetch = async (url, opts) => {
    const u = new URL(url);
    calls.push({ url: String(url), path: decodeURIComponent(u.pathname), query: Object.fromEntries(u.searchParams), opts });
    assert.equal(opts.headers['x-apikey'], KEY); assert.equal(opts.redirect, 'error'); assert.ok(opts.signal instanceof AbortSignal);
    if (api.status) return new Response(JSON.stringify({ title: 'err', reason: 'x', detail: 'x', status: api.status }), { status: api.status });
    const m = /^\/aeroapi\/flights\/(.+)$/.exec(decodeURIComponent(u.pathname));
    const id = m?.[1];
    if (api.byId[id]) return Response.json({ flights: [api.byId[id]], links: null, num_pages: 1 });
    const list = typeof api.byIdent[id] === 'function' ? api.byIdent[id]() : api.byIdent[id];
    if (!list) return new Response(JSON.stringify({ title: 'Not found', status: 404 }), { status: 404 });
    return Response.json({ flights: list, links: null, num_pages: 1 });
  };
  api.calls = calls;
  return api;
}

async function harness(t, { key = KEY, api = fakeAero(), time = NOW, store = fakeStore() } = {}) {
  const clock = { t: time };
  const logs = [];
  const ctx = { now: () => clock.t, log: (...a) => logs.push(a.join(' ')), store, fetch: api.fetch, config: {},
    secret: async (name, opts) => { assert.deepEqual(opts, { optional: true }); return name === AEROAPI_KEY ? key : null; } };
  ctx.events = fakeEvents(store, { now: () => clock.t });
  const notes = () => ctx.events.since(0).filter(e => e.type === 'notification');
  return { ctx, api, store, logs, clock, notes, set: (v) => { clock.t = v; }, advance: (ms) => { clock.t += ms; } };
}

test('ident normalisation: IATA, spaced, ICAO; a bare number needs the airline', () => {
  assert.deepEqual(parseIdent('UA4321'), { ident: 'UA4321', iata: 'UA', number: '4321', airlineName: 'United Airlines' });
  assert.deepEqual(parseIdent(' ua 4321 '), { ident: 'UA4321', iata: 'UA', number: '4321', airlineName: 'United Airlines' });
  assert.deepEqual(parseIdent('UAL4321'), { ident: 'UAL4321', iata: 'UA', number: '4321', airlineName: 'United Airlines' });
  assert.deepEqual(parseIdent('XX123'), { ident: 'XX123', iata: 'XX', number: '123', airlineName: null });
  assert.equal(parseIdent('B6 1234').iata, 'B6');
  for (const bad of ['123', ' 123 ', 123]) assert.throws(() => parseIdent(bad), (e) => e instanceof TravelError && e.status === 400 && e.message === 'airline_required');
  assert.throws(() => parseIdent('XX'), (e) => e.status === 400 && e.message === 'invalid_ident');
  assert.throws(() => parseIdent(''), (e) => e.status === 400);
});

test('picks the flight whose scheduled_out is on the requested local date (origin time zone)', () => {
  const prev = aero({ out: '2030-01-14T17:25:00Z' });
  const late = aero({ out: '2030-01-16T04:30:00Z' }); // 10:30 PM on the 21st in Dallas
  const next = aero({ out: '2030-01-16T17:25:00Z' });
  assert.equal(pickFlight([next, late, prev], '2030-01-15'), late);
  assert.equal(pickFlight([next, late, prev], '2030-01-16'), next);
  assert.equal(pickFlight([next, prev], '2030-01-17'), null);
  // A known fa_flight_id wins over date matching.
  assert.equal(pickFlight([late, next], '2030-01-15', next.fa_flight_id), next);
  // Tokyo origin: 2030-01-15T16:00Z is already the 22nd locally.
  const nrt = aero({ origin: { ...DAL, code_iata: 'NRT', timezone: 'Asia/Tokyo' }, out: '2030-01-15T16:00:00Z' });
  assert.equal(pickFlight([nrt], '2030-01-16'), nrt);
  assert.equal(pickFlight([nrt], '2030-01-15'), null);
});

test('status mapping including boarding and cancelled, with short status lines', () => {
  const f = aero();
  assert.equal(statusOf(f, NOW), 'scheduled');
  assert.equal(statusOf(aero({ delay: 25 }), NOW), 'delayed');
  assert.equal(statusOf(f, Date.parse(f.scheduled_out) - 30 * MIN), 'boarding');
  assert.equal(statusOf(aero({ delay: 60 }), Date.parse(f.scheduled_out) - 30 * MIN), 'delayed', 'boarding follows the estimated departure');
  assert.equal(statusOf({ ...f, actual_out: '2030-01-15T17:28:00Z' }, NOW), 'departed');
  assert.equal(statusOf({ ...f, actual_out: '2030-01-15T17:28:00Z', actual_off: '2030-01-15T17:38:00Z', progress_percent: 40 }, NOW), 'en_route');
  assert.equal(statusOf({ ...f, actual_out: 'x', actual_off: 'x', actual_on: '2030-01-15T18:24:00Z' }, NOW), 'landed');
  assert.equal(statusOf({ ...f, actual_out: 'x', actual_off: 'x', actual_on: 'x', actual_in: '2030-01-15T18:29:00Z' }, NOW), 'arrived');
  assert.equal(statusOf({ ...f, cancelled: true, status: 'Cancelled' }, NOW), 'cancelled');
  assert.equal(statusOf({ ...f, diverted: true }, NOW), 'diverted');

  const view = (raw, now = NOW) => { const s = snapshot(raw, now); const { landing, ...rest } = s; return statusText({ ...rest, _: { landing }, date: '2030-01-15' }); };
  assert.equal(view(f), 'On time, departs 11:25 AM');
  assert.equal(view(aero({ delay: 25 })), 'Delayed 25 min, departs 11:50 AM');
  assert.equal(view(f, Date.parse(f.scheduled_out) - 20 * MIN), 'Boarding at gate 7, departs 11:25 AM');
  assert.equal(view({ ...f, actual_out: '2030-01-15T17:28:00Z', actual_off: '2030-01-15T17:38:00Z', estimated_on: '2030-01-15T18:21:00Z' }), 'En route, lands 12:21 PM');
  assert.equal(view({ ...f, actual_out: 'x', actual_off: 'x', actual_on: 'x', actual_in: '2030-01-15T18:29:00Z', baggage_claim: '5' }), 'Arrived 12:29 PM, baggage claim 5');
  assert.equal(view({ ...f, cancelled: true }), 'Cancelled');
  const s = snapshot(aero({ delay: 25 }), NOW);
  assert.deepEqual(s.departure, { scheduled: '2030-01-15T17:25:00.000Z', estimated: '2030-01-15T17:50:00.000Z', actual: null, delayMin: 25, gate: '7', terminal: null,
    boarding: { time: '2030-01-15T17:10:00.000Z', scheduledTime: '2030-01-15T16:45:00.000Z', leadMin: 40, estimated: true } }); // XX: default 40 min lead
  assert.deepEqual(s.origin, { code: 'DAL', city: 'Dallas', name: 'Dallas Love Field', tz: 'America/Chicago' });
});

test('adaptive nextPollAt: 3 h, 30 min, 5 min, last poll after arrival, cancelled 15 min', () => {
  const flight = (raw, now) => { const { landing, ...s } = snapshot(raw, now); return { id: 'x', date: '2030-01-15', ...s, _: { landing } }; };
  const dep = Date.parse('2030-01-15T17:25:00Z');
  const f = flight(aero(), NOW);
  assert.equal(nextPollAt(f, dep - 30 * H), dep - 27 * H);                // > 24 h: every 3 h
  assert.equal(nextPollAt(f, dep - 25 * H), dep - 24 * H);                // ...but not past the 24 h boundary
  assert.equal(nextPollAt(f, dep - 10 * H), dep - 10 * H + 30 * MIN);     // 6-24 h: 30 min
  assert.equal(nextPollAt(f, dep - 2 * H), dep - 2 * H + 5 * MIN);        // inside 6 h: 5 min
  const air = flight({ ...aero(), actual_out: at(dep), actual_off: at(dep + 10 * MIN) }, dep + 20 * MIN);
  assert.equal(nextPollAt(air, dep + 20 * MIN), dep + 25 * MIN);
  const arrived = flight({ ...aero(), actual_out: at(dep), actual_off: 'x', actual_on: 'x', actual_in: at(dep + 64 * MIN) }, dep + 70 * MIN);
  assert.equal(nextPollAt(arrived, dep + 70 * MIN, 'en_route'), dep + 75 * MIN, 'one last poll');
  assert.equal(nextPollAt(arrived, dep + 75 * MIN, 'arrived'), null, 'then stop');
  const cx = flight({ ...aero(), cancelled: true }, NOW);
  assert.equal(nextPollAt(cx, NOW), NOW + 15 * MIN);
  assert.equal(nextPollAt(cx, dep + 65 * MIN + 6 * H + 1), null, 'until 6 h after scheduled arrival');
});

test('poll: AeroAPI request shape, inbound inside 6 h only, backoff on 429/5xx, no key never logged', async (t) => {
  const h = await harness(t);
  h.api.byIdent.XX123 = [aero({ out: '2030-01-14T17:25:00Z' }), aero(), aero({ out: '2030-01-16T17:25:00Z' })];
  h.set(NOW - 10 * H); // 13 h 25 min before departure
  const f = await addFlight(h.ctx, { ident: 'xx 123', date: '2030-01-15', label: 'To Houston' });
  assert.equal(f.id, 'XX123-2030-01-15'); assert.equal(f.ident, 'XX123'); assert.equal(f.label, 'To Houston');
  assert.equal(f.status, 'scheduled'); assert.equal(f.statusText, 'On time, departs 11:25 AM');
  assert.deepEqual(f.airline, { iata: 'XX', name: null }); assert.equal(f.number, '123');
  assert.equal(f.departure.scheduled, '2030-01-15T17:25:00.000Z'); assert.equal(f.arrival.gate, '12');
  assert.equal(f.nextPollAt, new Date(NOW - 10 * H + 30 * MIN).toISOString());
  assert.equal(h.api.calls.length, 1, 'no inbound fetch 13 h out');
  const c = h.api.calls[0];
  assert.equal(c.path, '/aeroapi/flights/XX123');
  assert.equal(c.query.start, '2030-01-14T10:00:00Z'); assert.equal(c.query.end, '2030-01-16T12:00:00Z');
  assert.equal(f.inbound, null);
  assert.ok(!('_' in f) && !('createdAt' in f));

  h.set(NOW); // inside 6 h: inbound aircraft is fetched
  const g = await pollFlight(h.ctx, f.id);
  assert.deepEqual(g.inbound, { ident: 'XX789', status: 'en_route', delayMin: 30 });
  assert.equal(h.api.calls.at(-1).path, `/aeroapi/flights/${INBOUND.fa_flight_id}`);
  assert.equal(g.nextPollAt, new Date(NOW + 5 * MIN).toISOString());

  h.api.status = 429;
  const steps = [];
  for (let i = 0; i < 5; i++) { const x = await pollFlight(h.ctx, f.id); steps.push((Date.parse(x.nextPollAt) - h.clock.t) / MIN); assert.equal(x.error, 'provider_error'); assert.equal(x.status, 'scheduled', 'last good data kept'); }
  assert.deepEqual(steps, [10, 20, 40, 60, 60]);
  h.api.status = 503;
  assert.equal((await pollFlight(h.ctx, f.id)).error, 'provider_error');
  h.api.status = null;
  const ok = await pollFlight(h.ctx, f.id);
  assert.equal(ok.error, null); assert.equal(Date.parse(ok.nextPollAt) - h.clock.t, 5 * MIN, 'backoff resets');
  assert.ok(h.logs.some(l => l === 'travel provider_429'));
  assert.ok(h.logs.every(l => !l.includes(KEY)), 'the API key is never logged');

  // Beyond AeroAPI's two-day look-ahead nothing is fetched yet.
  const before = h.api.calls.length;
  const far = await addFlight(h.ctx, { ident: 'XX123', date: '2030-01-24' });
  assert.equal(h.api.calls.length, before); assert.equal(far.error, null); assert.equal(far.status, 'unknown');
  assert.equal(far.statusText, 'Tracking starts 2 days before');
  // Unknown flight on a covered date: not_found.
  const nf = await addFlight(h.ctx, { ident: 'XX9999', date: '2030-01-15' });
  assert.equal(nf.error, 'not_found');
});

test('poller ticks only due flights and never polls a flight after its final post-arrival poll', async (t) => {
  const h = await harness(t);
  const dep = Date.parse('2030-01-15T17:25:00Z');
  let raw = aero();
  h.api.byIdent.XX123 = () => [raw];
  await addFlight(h.ctx, { ident: 'XX123', date: '2030-01-15' });
  const poller = createTravelPoller(h.ctx);
  const n0 = h.api.calls.length;
  assert.equal(await poller.tick(), 0, 'not due yet');
  assert.equal(h.api.calls.length, n0);
  h.advance(5 * MIN);
  assert.equal(await poller.tick(), 1);
  raw = { ...aero(), actual_out: at(dep), actual_off: at(dep + 10 * MIN), actual_on: at(dep + 60 * MIN), actual_in: at(dep + 64 * MIN), baggage_claim: '5' };
  h.set(dep + 70 * MIN); await poller.tick();
  h.advance(5 * MIN); await poller.tick();
  const doc = h.store.get(TRAVEL_FLIGHTS, 'XX123-2030-01-15');
  assert.equal(doc.status, 'arrived'); assert.equal(doc.nextPollAt, null);
  const n1 = h.api.calls.length;
  h.advance(H); assert.equal(await poller.tick(), 0); assert.equal(h.api.calls.length, n1);
  // Refresh skips it too; the list drops it 12 h after arrival and the store deletes it after 3 days.
  await refreshAll(h.ctx); assert.equal(h.api.calls.length, n1);
  h.set(dep + 64 * MIN + 13 * H); assert.equal((await travelView(h.ctx)).flights.length, 0);
  assert.ok(h.store.get(TRAVEL_FLIGHTS, 'XX123-2030-01-15'));
  h.set(dep + 64 * MIN + 3 * 24 * H + MIN); await travelView(h.ctx);
  assert.equal(h.store.get(TRAVEL_FLIGHTS, 'XX123-2030-01-15'), null);
  poller.start(); poller.stop();
});

test('delay change: popup inside the popup window, stream outside; smaller changes nothing', async (t) => {
  const h = await harness(t);
  let raw = aero();
  h.api.byIdent.XX123 = () => [raw];
  h.set(NOW - 6 * H); // 9 h 25 min before departure: outside the 4 h window
  await addFlight(h.ctx, { ident: 'XX123', date: '2030-01-15' });
  assert.equal(h.notes().length, 0, 'first data is a baseline');
  raw = aero({ delay: 10 }); await pollFlight(h.ctx, 'XX123-2030-01-15');
  assert.equal(h.notes().length, 0, 'below the 15 min threshold');
  raw = aero({ delay: 25 }); await pollFlight(h.ctx, 'XX123-2030-01-15');
  let n = h.notes();
  assert.equal(n.length, 1);
  assert.equal(n[0].route, 'stream'); assert.equal(n[0].title, 'XX123 delayed 25 min'); assert.equal(n[0].body, 'Delayed 25 min. Departs 11:50 AM from gate 7.');
  assert.equal(n[0].source, 'Travel'); assert.equal(n[0].icon, 'plane'); assert.deepEqual(n[0].open, { screen: 'travel', flightId: 'XX123-2030-01-15', args: { flightId: 'XX123-2030-01-15' } });
  h.set(NOW + H); // inside the window (the estimated departure moves with the delay)
  raw = aero({ delay: 35 }); await pollFlight(h.ctx, 'XX123-2030-01-15');
  assert.equal(h.notes().length, 1, '25 -> 35 is below the threshold relative to the last notified 25');
  raw = aero({ delay: 45 }); await pollFlight(h.ctx, 'XX123-2030-01-15');
  n = h.notes(); assert.equal(n.length, 2);
  assert.equal(n[1].route, 'popup'); assert.equal(n[1].title, 'XX123 delayed 45 min');
  raw = aero({ delay: 5 }); await pollFlight(h.ctx, 'XX123-2030-01-15');
  n = h.notes(); assert.equal(n.at(-1).title, 'XX123 back on time'); assert.equal(n.at(-1).route, 'popup');
  // Settings: delays off silences it.
  await saveSettings(h.ctx, { notify: { delays: false } });
  raw = aero({ delay: 50 }); await pollFlight(h.ctx, 'XX123-2030-01-15');
  assert.equal(h.notes().length, 3);
});

test('gate change inside the window pops up; boarding pops up once; departed/arrived stream with baggage and connection gate', async (t) => {
  const h = await harness(t);
  const dep = Date.parse('2030-01-15T17:25:00Z');
  let a = aero(), b = aero({ ident: 'XXX100', iata: 'XX100', number: '100', origin: HOU, destination: MSY, out: '2030-01-15T19:30:00Z', gate_origin: '4', gate_destination: 'B2' });
  h.api.byIdent.XX123 = () => [a]; h.api.byIdent.XX100 = () => [b];
  await addFlight(h.ctx, { ident: 'XX123', date: '2030-01-15' });
  await addFlight(h.ctx, { ident: 'XX100', date: '2030-01-15' });
  a = aero({ gate_origin: '9' }); await pollFlight(h.ctx, 'XX123-2030-01-15');
  let n = h.notes();
  assert.equal(n.length, 1); assert.equal(n[0].route, 'popup'); assert.equal(n[0].title, 'XX123 now gate 9'); assert.equal(n[0].body, 'Was gate 7. Departs 11:25 AM.');
  h.set(dep - 30 * MIN); await pollFlight(h.ctx, 'XX123-2030-01-15');
  n = h.notes(); assert.equal(n.length, 2); assert.equal(n[1].title, 'XX123 boarding'); assert.equal(n[1].route, 'popup'); assert.equal(n[1].body, 'Boarding now at gate 9. Departs 11:25 AM.');
  h.advance(5 * MIN); await pollFlight(h.ctx, 'XX123-2030-01-15');
  assert.equal(h.notes().length, 2, 'boarding only once');
  a = { ...aero({ gate_origin: '9' }), actual_out: at(dep + 2 * MIN), actual_off: at(dep + 12 * MIN), progress_percent: 5 };
  h.set(dep + 15 * MIN); await pollFlight(h.ctx, 'XX123-2030-01-15');
  n = h.notes(); assert.equal(n.length, 3); assert.equal(n[2].title, 'XX123 departed DAL'); assert.equal(n[2].route, 'stream'); assert.equal(n[2].body, 'Lands 12:25 PM in HOU.');
  a = { ...a, actual_on: at(dep + 58 * MIN), actual_in: at(dep + 63 * MIN), baggage_claim: '5', progress_percent: 100 };
  h.set(dep + 70 * MIN); await pollFlight(h.ctx, 'XX123-2030-01-15');
  n = h.notes(); assert.equal(n.length, 4);
  assert.equal(n[3].title, 'XX123 arrived at gate 12'); assert.equal(n[3].route, 'stream');
  assert.equal(n[3].body, 'Gate 12. Baggage claim 5. Connection XX100 at gate 4, departs 1:30 PM.');
});

test('one merged notification per poll; no repeat after a restart on the same store', async (t) => {
  const h = await harness(t);
  let a = aero();
  const b = aero({ ident: 'XXX100', iata: 'XX100', number: '100', origin: HOU, destination: MSY, out: '2030-01-15T19:30:00Z', gate_origin: '4' });
  h.api.byIdent.XX123 = () => [a]; h.api.byIdent.XX100 = () => [b];
  await addFlight(h.ctx, { ident: 'XX123', date: '2030-01-15' });
  await addFlight(h.ctx, { ident: 'XX100', date: '2030-01-15' });
  let view = await travelView(h.ctx);
  assert.deepEqual(view.connections, [{ fromId: 'XX123-2030-01-15', toId: 'XX100-2030-01-15', airport: 'HOU', layoverMin: 60, minConnectMin: 35, status: 'ok', text: '60 min in HOU, gate 12 -> 4' }]);
  assert.deepEqual(view.flights.map(f => f.id), ['XX123-2030-01-15', 'XX100-2030-01-15']);
  a = aero({ delay: 20 }); // arrival 12:50 -> 40 min layover: tight
  await pollFlight(h.ctx, 'XX123-2030-01-15');
  const n = h.notes();
  assert.equal(n.length, 1, 'delay + connection merge into one');
  assert.equal(n[0].route, 'popup'); assert.equal(n[0].title, 'XX123 delayed 20 min');
  assert.equal(n[0].body, 'Delayed 20 min. Departs 11:45 AM from gate 7. Boards ~11:05 AM. Connection in HOU now 40 min (tight).');
  assert.equal(h.store.all('notifications').filter(x => x.source === 'Travel').length, 1);
  // Polling the other leg sees the same connection state: nothing new.
  await pollFlight(h.ctx, 'XX100-2030-01-15');
  assert.equal(h.notes().length, 1);

  await h.store.flushed();
  const h2 = await harness(t, { store: h.store, api: h.api, time: h.clock.t });
  await pollFlight(h2.ctx, 'XX123-2030-01-15');
  await pollFlight(h2.ctx, 'XX100-2030-01-15');
  assert.equal(h2.store.all('notifications').filter(x => x.source === 'Travel').length, 1, 'no repeat after restart');
  // The travel refresh hint supersedes: one pending event however many changes.
  assert.equal(h2.ctx.events.since(0).filter(e => e.type === 'travel').length, 1);
});

test('connections ok/tight/at_risk/missed; worsening pops up, recovery streams', async (t) => {
  const A = (arrIn, extra = {}) => ({ id: 'A', destination: { code: 'HOU' }, origin: { code: 'DAL' }, status: 'scheduled',
    arrival: { scheduled: '2030-01-15T18:30:00.000Z', estimated: arrIn, actual: null, gate: '12', ...extra }, departure: { scheduled: '2030-01-15T17:25:00.000Z' } });
  const B = (extra = {}) => ({ id: 'B', origin: { code: 'HOU' }, destination: { code: 'MSY' }, status: 'scheduled',
    departure: { scheduled: '2030-01-15T19:30:00.000Z', estimated: null, actual: null, gate: '4', ...extra }, arrival: { scheduled: '2030-01-15T20:35:00.000Z' } });
  const st = (a, b) => connections([a, b], DEFAULT_SETTINGS)[0];
  assert.equal(st(A(null), B()).status, 'ok');
  assert.equal(st(A('2030-01-15T18:50:00Z'), B()).status, 'tight');     // 40 min
  assert.equal(st(A('2030-01-15T19:05:00Z'), B()).status, 'at_risk');   // 25 min
  assert.equal(st(A('2030-01-15T19:35:00Z'), B()).status, 'missed');    // -5 min
  assert.equal(st(A('2030-01-15T19:35:00Z'), B()).text, 'Missed connection in HOU, gate 12 -> 4');
  assert.equal(st(A('2030-01-15T19:00:00Z'), B({ actual: '2030-01-15T19:20:00Z' })).status, 'missed', 'B left before A arrived');
  assert.equal(st(A(null, { actual: '2030-01-15T18:20:00Z' }), B({ actual: '2030-01-15T19:31:00Z' })).status, 'ok');
  assert.equal(connections([A(null), B({ scheduled: '2030-01-16T19:30:00.000Z' })]).length, 0, 'more than 24 h later is not a connection');
  assert.equal(connections([A(null), B({ scheduled: '2030-01-15T18:00:00.000Z' })]).length, 0, 'before A arrives is not a connection');
  assert.equal(connections([A(null), { ...B(), origin: { code: 'AUS' } }]).length, 0);

  const h = await harness(t);
  let a = aero();
  h.api.byIdent.XX123 = () => [a];
  h.api.byIdent.XX100 = () => [aero({ ident: 'XXX100', iata: 'XX100', number: '100', origin: HOU, destination: MSY, out: '2030-01-15T19:30:00Z', gate_origin: '4' })];
  h.set(NOW); // inside the earlier flight's popup window
  await addFlight(h.ctx, { ident: 'XX123', date: '2030-01-15' });
  await addFlight(h.ctx, { ident: 'XX100', date: '2030-01-15' });
  await saveSettings(h.ctx, { notify: { delays: false } });
  a = aero({ delay: 35 }); await pollFlight(h.ctx, 'XX123-2030-01-15'); // 25 min: at risk
  let n = h.notes();
  assert.equal(n.length, 1); assert.equal(n[0].route, 'popup'); assert.equal(n[0].title, 'Connection at risk in HOU'); assert.equal(n[0].body, '25 min in HOU, gate 12 -> 4.');
  a = aero({ delay: 70 }); await pollFlight(h.ctx, 'XX123-2030-01-15'); // -10: missed
  n = h.notes(); assert.equal(n.length, 2); assert.equal(n[1].title, 'Connection missed in HOU'); assert.equal(n[1].route, 'popup');
  a = aero({ delay: 0 }); await pollFlight(h.ctx, 'XX123-2030-01-15'); // recovers
  n = h.notes(); assert.equal(n.length, 3); assert.equal(n[2].title, 'Connection in HOU OK again'); assert.equal(n[2].route, 'stream');
});

test('cancelled pops up regardless of window or toggles', async (t) => {
  const h = await harness(t);
  let a = aero();
  h.api.byIdent.XX123 = () => [a];
  h.set(NOW - 20 * H);
  await addFlight(h.ctx, { ident: 'XX123', date: '2030-01-15' });
  a = { ...aero(), cancelled: true, status: 'Cancelled' };
  const f = await pollFlight(h.ctx, 'XX123-2030-01-15');
  assert.equal(f.status, 'cancelled'); assert.equal(f.nextPollAt, new Date(h.clock.t + 15 * MIN).toISOString());
  const n = h.notes();
  assert.equal(n.length, 1); assert.equal(n[0].title, 'XX123 cancelled'); assert.equal(n[0].route, 'popup');
  assert.equal(n[0].body, 'DAL -> HOU, was due to depart 11:25 AM.');
});

test('settings validation and partial merge', async (t) => {
  const h = await harness(t);
  assert.deepEqual(getSettings(h.ctx), DEFAULT_SETTINGS);
  const s = await saveSettings(h.ctx, { delayThresholdMin: 20, notify: { gates: false } });
  assert.equal(s.delayThresholdMin, 20); assert.equal(s.notify.gates, false); assert.equal(s.notify.delays, true); assert.equal(s.minConnectMin, 35);
  for (const bad of [{ delayThresholdMin: 0 }, { minConnectMin: 1.5 }, { popupWindowH: 'x' }, { notify: { delays: 1 } }, { notify: { other: true } }, { other: 1 }, [], null])
    await assert.rejects(saveSettings(h.ctx, bad), (e) => e.status === 400 && e.message === 'invalid_settings');
  assert.equal(getSettings(h.ctx).delayThresholdMin, 20);
});

// ---- review fixes ---------------------------------------------------------------------------------------------------
const legB = (o = {}) => aero({ ident: 'XXX100', iata: 'XX100', number: '100', origin: HOU, destination: MSY, out: '2030-01-15T19:30:00Z', gate_origin: '4', ...o });

test('first success announces what is already remarkable; on time is a silent baseline', async (t) => {
  const h = await harness(t);
  h.api.byIdent.XX123 = [{ ...aero(), cancelled: true }];
  await addFlight(h.ctx, { ident: 'XX123', date: '2030-01-15' });
  let n = h.notes(); assert.equal(n.length, 1); assert.equal(n[0].title, 'XX123 cancelled'); assert.equal(n[0].route, 'popup');

  const h2 = await harness(t);
  h2.api.byIdent.XX123 = [aero({ delay: 40 })];
  await addFlight(h2.ctx, { ident: 'XX123', date: '2030-01-15' }); // 3 h 25 min out: inside the window
  n = h2.notes(); assert.equal(n.length, 1); assert.equal(n[0].title, 'XX123 delayed 40 min'); assert.equal(n[0].route, 'popup');

  const h3 = await harness(t, { time: NOW - 10 * H });
  h3.api.byIdent.XX123 = [aero({ delay: 40 })];
  await addFlight(h3.ctx, { ident: 'XX123', date: '2030-01-15' });
  assert.equal(h3.notes()[0].route, 'stream', 'outside the window a first-seen delay streams');

  // A connection's first appearance: at risk pops up, tight streams, ok is silent.
  for (const [delay, route, title] of [[35, 'popup', 'Connection at risk in HOU'], [20, 'stream', 'Tight connection in HOU'], [0, null, null]]) {
    const c = await harness(t);
    c.api.byIdent.XX123 = [aero({ delay })]; c.api.byIdent.XX100 = [legB()];
    await saveSettings(c.ctx, { notify: { delays: false } });
    await addFlight(c.ctx, { ident: 'XX123', date: '2030-01-15' });
    assert.equal(c.notes().length, 0);
    await addFlight(c.ctx, { ident: 'XX100', date: '2030-01-15' });
    const cn = c.notes();
    if (!route) { assert.equal(cn.length, 0); continue; }
    assert.equal(cn.length, 1, `delay ${delay}`); assert.equal(cn[0].route, route); assert.equal(cn[0].title, title);
  }
});

test('delay titles follow the threshold: delayed, departs early, back on time; body states the delay', async (t) => {
  const h = await harness(t);
  let raw = aero();
  h.api.byIdent.XX123 = () => [raw];
  await saveSettings(h.ctx, { delayThresholdMin: 20 });
  await addFlight(h.ctx, { ident: 'XX123', date: '2030-01-15' });
  const poll = async (delay) => { raw = aero({ delay }); await pollFlight(h.ctx, 'XX123-2030-01-15'); return h.notes().at(-1); };
  assert.equal((await poll(15)), undefined, 'below a 20 min threshold');
  let n = await poll(25); assert.equal(n.title, 'XX123 delayed 25 min'); assert.equal(n.body, 'Delayed 25 min. Departs 11:50 AM from gate 7. Boards ~11:10 AM.');
  n = await poll(3); assert.equal(n.title, 'XX123 back on time'); assert.equal(n.body, 'Now on time. Departs 11:28 AM from gate 7. Boards ~10:48 AM.');
  n = await poll(-20); assert.equal(n.title, 'XX123 departs 20 min early'); assert.equal(n.body, 'Departs 20 min early. Departs 11:05 AM from gate 7. Boards ~10:25 AM.');
  n = await poll(16); assert.equal(n.title, 'XX123 back on time', '-20 -> 16 is a 36 min change, but 16 is below the threshold');
  assert.equal(h.notes().length, 4);
});

test('connection hysteresis: 49/50 min flapping pops up once; recovery needs 5 min margin; no re-popup within 30 min', async (t) => {
  const h = await harness(t);
  let delay = 10; // layover = 60 - delay
  h.api.byIdent.XX123 = () => [aero({ delay })]; h.api.byIdent.XX100 = [legB()];
  await saveSettings(h.ctx, { notify: { delays: false } });
  await addFlight(h.ctx, { ident: 'XX123', date: '2030-01-15' });
  await addFlight(h.ctx, { ident: 'XX100', date: '2030-01-15' }); // 50 min: ok, silent
  const poll = async (d) => { delay = d; h.advance(5 * MIN); await pollFlight(h.ctx, 'XX123-2030-01-15'); return h.notes().length; };
  assert.equal(await poll(11), 1); assert.equal(h.notes()[0].title, 'Tight connection in HOU'); // 49
  assert.equal(await poll(10), 1); assert.equal(await poll(11), 1); assert.equal(await poll(9), 1); // 50, 49, 51: still tight
  assert.equal(await poll(5), 2); assert.equal(h.notes()[1].title, 'Connection in HOU OK again'); assert.equal(h.notes()[1].route, 'stream'); // 55
  assert.equal(await poll(11), 2, 'tight again within 30 min of the last tight popup: nothing');
  assert.equal(connectionStatus({ status: 'ok', layoverMin: 52, minConnectMin: 35 }, 'tight'), 'tight');
  assert.equal(connectionStatus({ status: 'ok', layoverMin: 55, minConnectMin: 35 }, 'tight'), 'ok');
  assert.equal(connectionStatus({ status: 'tight', layoverMin: 38, minConnectMin: 35 }, 'at_risk'), 'at_risk');
  assert.equal(connectionStatus({ status: 'ok', layoverMin: 60, minConnectMin: 35 }, 'at_risk'), 'ok');
  h.advance(31 * MIN);
  assert.equal(await poll(5), 3); // recovers (stream)
  assert.equal(await poll(11), 4); assert.equal(h.notes()[3].route, 'popup', 'after 30 min the same worsening pops up again');
});

test('popup window opens at the scheduled departure even when delayed; connection worsening outside it streams', async (t) => {
  const h = await harness(t, { time: Date.parse('2030-01-15T16:25:00Z') }); // 1 h before scheduled departure
  let raw = aero();
  h.api.byIdent.XX123 = () => [raw];
  await addFlight(h.ctx, { ident: 'XX123', date: '2030-01-15' });
  raw = aero({ delay: 240 }); await pollFlight(h.ctx, 'XX123-2030-01-15');
  assert.equal(h.notes()[0].route, 'popup', '4 h delay on a flight 1 h out still pops up');

  const c = await harness(t, { time: NOW - 8 * H });
  let d = 0;
  c.api.byIdent.XX123 = () => [aero({ delay: d })]; c.api.byIdent.XX100 = [legB()];
  await saveSettings(c.ctx, { notify: { delays: false } });
  await addFlight(c.ctx, { ident: 'XX123', date: '2030-01-15' }); await addFlight(c.ctx, { ident: 'XX100', date: '2030-01-15' });
  d = 35; await pollFlight(c.ctx, 'XX123-2030-01-15');
  assert.equal(c.notes()[0].title, 'Connection at risk in HOU'); assert.equal(c.notes()[0].route, 'stream');
});

test('cancel body names the affected connection', async (t) => {
  const h = await harness(t);
  let a = aero();
  h.api.byIdent.XX123 = () => [a]; h.api.byIdent.XX100 = [legB()];
  await addFlight(h.ctx, { ident: 'XX123', date: '2030-01-15' }); await addFlight(h.ctx, { ident: 'XX100', date: '2030-01-15' });
  a = { ...aero(), cancelled: true }; await pollFlight(h.ctx, 'XX123-2030-01-15');
  const n = h.notes(); assert.equal(n.length, 1);
  assert.equal(n[0].body, 'DAL -> HOU, was due to depart 11:25 AM. Connection to XX100 in HOU affected.');
});

test('a poll in flight never resurrects a deleted flight or notifies for it', async (t) => {
  const h = await harness(t);
  h.api.byIdent.XX123 = [aero()];
  await addFlight(h.ctx, { ident: 'XX123', date: '2030-01-15' });
  let release; const gate = new Promise(r => { release = r; });
  const inner = h.ctx.fetch;
  h.ctx.fetch = async (url, opts) => { await gate; return inner(url, opts); };
  h.api.byIdent.XX123 = [{ ...aero(), cancelled: true }];
  const job = pollFlight(h.ctx, 'XX123-2030-01-15');
  await new Promise(r => setImmediate(r));
  assert.equal(await removeFlight(h.ctx, 'XX123-2030-01-15'), true);
  release();
  assert.equal(await job, null);
  assert.equal(h.store.get(TRAVEL_FLIGHTS, 'XX123-2030-01-15'), null);
  assert.equal(h.notes().length, 0);
});

test('inbound aircraft fetched at most every 20 min and never once it has landed', async (t) => {
  const h = await harness(t);
  h.api.byIdent.XX123 = [aero()];
  const inboundCalls = () => h.api.calls.filter(c => c.path.includes(INBOUND.fa_flight_id)).length;
  await addFlight(h.ctx, { ident: 'XX123', date: '2030-01-15' });
  assert.equal(inboundCalls(), 1);
  for (let i = 0; i < 3; i++) { h.advance(5 * MIN); await pollFlight(h.ctx, 'XX123-2030-01-15'); }
  assert.equal(inboundCalls(), 1, '15 min later: not yet');
  h.advance(6 * MIN); h.api.byId[INBOUND.fa_flight_id] = { ...INBOUND, actual_on: '2030-01-15T14:15:00Z' };
  const f = await pollFlight(h.ctx, 'XX123-2030-01-15');
  assert.equal(inboundCalls(), 2); assert.equal(f.inbound.status, 'landed');
  for (let i = 0; i < 6; i++) { h.advance(10 * MIN); await pollFlight(h.ctx, 'XX123-2030-01-15'); }
  assert.equal(inboundCalls(), 2, 'landed inbound is not fetched again');
});

test('landed without gate arrival: 5 min for an hour, then 30 min, stop 2 h after touchdown', () => {
  const on = Date.parse('2030-01-15T18:24:00Z');
  const { landing, ...snap } = snapshot({ ...aero(), actual_out: 'x', actual_off: 'x', actual_on: at(on) }, on);
  const f = { id: 'x', date: '2030-01-15', ...snap, _: { landing } };
  assert.equal(f.status, 'landed');
  assert.equal(nextPollAt(f, on + 30 * MIN), on + 35 * MIN);
  assert.equal(nextPollAt(f, on + 70 * MIN), on + 100 * MIN);
  assert.equal(nextPollAt(f, on + 2 * H), null);
});

test('same-day multi-leg flight number: the earliest leg not yet arrived, then the stored leg is kept', async (t) => {
  const leg1 = { ...aero({ out: '2030-01-15T13:00:00Z' }), actual_out: 'x', actual_off: 'x', actual_on: 'x', actual_in: '2030-01-15T14:05:00Z', fa_flight_id: 'XXX123-leg1' };
  const leg2 = aero({ origin: HOU, destination: MSY, out: '2030-01-15T17:25:00Z', fa_flight_id: 'XXX123-leg2' });
  assert.equal(pickFlight([leg2, leg1], '2030-01-15'), leg2);
  assert.equal(pickFlight([leg2, leg1], '2030-01-15', 'XXX123-leg1'), leg1);
  const h = await harness(t);
  let list = [leg1, leg2];
  h.api.byIdent.XX123 = () => list;
  const f = await addFlight(h.ctx, { ident: 'XX123', date: '2030-01-15' });
  assert.equal(f.origin.code, 'HOU');
  list = [leg1, { ...leg2, actual_out: 'x', actual_off: 'x', actual_on: 'x', actual_in: '2030-01-15T18:31:00Z' }];
  assert.equal((await pollFlight(h.ctx, f.id)).origin.code, 'HOU', 'stored leg kept after it arrives');
});

// ---- estimated boarding ---------------------------------------------------------------------------------------------
test('boarding estimate: airline lead table, settings override, null without a time or when cancelled', () => {
  assert.equal(boardingLead(DEFAULT_SETTINGS, 'WN'), 35); assert.equal(boardingLead(DEFAULT_SETTINGS, 'UA'), 35);
  assert.equal(boardingLead(DEFAULT_SETTINGS, 'AA'), 40); assert.equal(boardingLead(DEFAULT_SETTINGS, 'ZZ'), 40); assert.equal(BOARDING_LEAD_MIN.default, 40);
  assert.equal(boardingLead({ ...DEFAULT_SETTINGS, boardingLeadMin: 55 }, 'WN'), 55);
  const dep = { scheduled: '2030-01-15T17:25:00.000Z', estimated: '2030-01-15T17:50:00.000Z' };
  assert.deepEqual(boardingOf(dep, 'delayed', 35), { time: '2030-01-15T17:15:00.000Z', scheduledTime: '2030-01-15T16:50:00.000Z', leadMin: 35, estimated: true });
  assert.equal(boardingOf({ scheduled: null, estimated: null }, 'scheduled', 35), null);
  assert.equal(boardingOf(dep, 'cancelled', 35), null); assert.equal(boardingOf(dep, 'diverted', 35), null);
  assert.equal(snapshot({ ...aero(), cancelled: true }, NOW).departure.boarding, null);
  // Status boarding follows the lead: UA 35 min, AA (and unknown airlines) 40 min.
  const sOut = Date.parse('2030-01-15T17:25:00Z'), ua = aero({ iata: 'UA9002', ident: 'UAL9002' });
  assert.equal(snapshot(ua, sOut - 38 * MIN).status, 'scheduled');
  assert.equal(snapshot(ua, sOut - 35 * MIN).status, 'boarding');
  assert.equal(snapshot(aero(), sOut - 38 * MIN).status, 'boarding');
  assert.equal(snapshot(aero({ iata: 'AA9001', ident: 'AAL9001' }), sOut - 38 * MIN).status, 'boarding');
  assert.equal(snapshot(aero(), sOut - 50 * MIN, 60).status, 'boarding');
});

test('boarding times in status lines, the boarding popup and settings', async (t) => {
  const h = await harness(t, { time: Date.parse('2030-01-15T15:00:00Z') }); // 2 h 25 min before departure
  let raw = aero();
  h.api.byIdent.XX123 = () => [raw];
  let f = await addFlight(h.ctx, { ident: 'XX123', date: '2030-01-15' });
  assert.equal(f.statusText, 'Boards 10:45 AM, gate 7');
  assert.deepEqual(f.departure.boarding, { time: '2030-01-15T16:45:00.000Z', scheduledTime: '2030-01-15T16:45:00.000Z', leadMin: 40, estimated: true });
  raw = aero({ delay: 25 }); f = await pollFlight(h.ctx, f.id);
  assert.equal(f.statusText, 'Delayed 25 min, boards 11:10 AM');
  assert.equal(h.notes().at(-1).body, 'Delayed 25 min. Departs 11:50 AM from gate 7. Boards ~11:10 AM.');
  // Settings: validated, null = airline default, applied to stored flights at once.
  for (const bad of [5, 91, '40']) await assert.rejects(saveSettings(h.ctx, { boardingLeadMin: bad }), (e) => e.status === 400);
  await saveSettings(h.ctx, { boardingLeadMin: 60 });
  let view = await travelView(h.ctx);
  assert.equal(view.settings.boardingLeadMin, 60); assert.equal(view.flights[0].departure.boarding.time, '2030-01-15T16:50:00.000Z');
  assert.equal(view.flights[0].statusText, 'Delayed 25 min, boards 10:50 AM');
  await saveSettings(h.ctx, { boardingLeadMin: null });
  view = await travelView(h.ctx);
  assert.equal(view.settings.boardingLeadMin, null); assert.equal(view.flights[0].departure.boarding.leadMin, 40);
  // More than 3 h out the line keeps the departure time.
  h.set(Date.parse('2030-01-15T13:00:00Z'));
  assert.equal((await travelView(h.ctx)).flights[0].statusText, 'Delayed 25 min, departs 11:50 AM');
  // Boarding popup leads with the gate (no gate: just "Boarding now").
  h.set(Date.parse('2030-01-15T17:16:00Z')); raw = aero({ delay: 25, gate_origin: null });
  await pollFlight(h.ctx, f.id);
  const n = h.notes().at(-1);
  assert.equal(n.title, 'XX123 boarding'); assert.equal(n.route, 'popup'); assert.equal(n.body, 'Boarding now. Departs 11:50 AM.');
});
