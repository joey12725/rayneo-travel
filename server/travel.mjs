// Travel (flight tracking), contract in docs/spec.md: the FlightAware AeroAPI v4 adapter, flight snapshots,
// connections, the adaptive poller and Travel notifications. Dependency-free; everything external comes from `ctx`:
//   ctx.fetch(url, opts)            WHATWG fetch (AeroAPI calls)
//   ctx.now()                       epoch ms
//   ctx.store                       document store: all(c), get(c, id), put(c, doc) -> doc, del(c, id) -> bool, flushed()
//   ctx.events.publish(type, data, opts)   change hints ('travel') and notifications ('notification')
//   ctx.secret(name, {optional})    resolves the AeroAPI key (FLIGHTAWARE_AEROAPI_KEY)
//   ctx.log(line)                   optional; never receives the key
//   ctx.config.tz                   the wearer's home zone for "today" and fallback clocks (default UTC)
//   ctx.config.travelTickMs         optional poller tick (default 60 s)
// Store: travel-flights (one document per flight, internal state under `_`), travel-settings ('settings'),
// travel-notified (last notified state per flight id and per connection 'conn:<from>><to>', so restarts never repeat),
// notifications (one merged row per poll, also published as a 'notification' event).
// AeroAPI is billed per call: a flight is fetched only when its nextPollAt has passed (or on an explicit refresh),
// never beyond AeroAPI's two-day look-ahead, never after its final post-arrival poll.

/** HTTP-style error: `status` is the HTTP status, `message` the machine-readable code (airline_required, ...). */
export class TravelError extends Error {
  constructor(status, message, detail) { super(message); this.name = 'TravelError'; this.status = status; this.detail = detail; }
}
let ErrorClass = TravelError;
/** Hosts with their own HTTP error class (for `instanceof` checks in their router) register it once at startup. */
export function setHttpError(Cls) { ErrorClass = typeof Cls === 'function' ? Cls : TravelError; }
/** An error of the registered class (TravelError unless the host called setHttpError). */
export const httpError = (status, message) => new ErrorClass(status, message);

export const TRAVEL_FLIGHTS = 'travel-flights';
export const TRAVEL_SETTINGS = 'travel-settings';
export const TRAVEL_NOTIFIED = 'travel-notified';
export const AEROAPI = 'https://aeroapi.flightaware.com/aeroapi';
export const AEROAPI_KEY = 'FLIGHTAWARE_AEROAPI_KEY';
const MIN = 60000, H = 3600000, D = 86400000;
const HORIZON_MS = 2 * D - 10 * MIN;   // /flights/{ident} answers at most two days ahead (end beyond that is a 400)
const LOOKBACK_MS = 10 * D - 10 * MIN; // ...and at most ten days back
const TIMEOUT_MS = 8000;
export const DEFAULT_SETTINGS = Object.freeze({
  notify: Object.freeze({ delays: true, gates: true, connection: true, departures: true, arrivals: true }),
  delayThresholdMin: 15, minConnectMin: 35, popupWindowH: 4,
  boardingLeadMin: null, // null = the airline's default (BOARDING_LEAD_MIN)
});
// AeroAPI has no boarding time: boarding is estimated as gate departure minus this lead, per airline (IATA).
export const BOARDING_LEAD_MIN = Object.freeze({ WN: 35, AA: 40, DL: 40, UA: 35, B6: 40, AS: 40, NK: 40, F9: 40, default: 40 });
export const boardingLead = (settings, iata) => typeof settings?.boardingLeadMin === 'number' ? settings.boardingLeadMin
  : BOARDING_LEAD_MIN[iata] ?? BOARDING_LEAD_MIN.default;

// IATA -> [ICAO, name] for display and for mapping an ICAO ident (UAL123) to its airline.
const AIRLINES = {
  WN: ['SWA', 'Southwest Airlines'], AA: ['AAL', 'American Airlines'], DL: ['DAL', 'Delta Air Lines'], UA: ['UAL', 'United Airlines'],
  AS: ['ASA', 'Alaska Airlines'], B6: ['JBU', 'JetBlue'], NK: ['NKS', 'Spirit Airlines'], F9: ['FFT', 'Frontier Airlines'],
  G4: ['AAY', 'Allegiant Air'], HA: ['HAL', 'Hawaiian Airlines'], SY: ['SCX', 'Sun Country Airlines'], AC: ['ACA', 'Air Canada'],
  WS: ['WJA', 'WestJet'], AM: ['AMX', 'Aeromexico'], Y4: ['VOI', 'Volaris'], BA: ['BAW', 'British Airways'], LH: ['DLH', 'Lufthansa'],
  AF: ['AFR', 'Air France'], KL: ['KLM', 'KLM'], VS: ['VIR', 'Virgin Atlantic'], MX: ['MXA', 'Breeze Airways'],
};
const ICAO_TO_IATA = Object.fromEntries(Object.entries(AIRLINES).map(([iata, [icao]]) => [icao, iata]));

const ms = (v) => { const t = typeof v === 'number' ? v : Date.parse(v ?? ''); return Number.isFinite(t) ? t : null; };
const iso = (v) => { const t = ms(v); return t === null ? null : new Date(t).toISOString(); };
const aeroTime = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
const str = (v) => typeof v === 'string' && v.trim() ? v.trim() : null;
const log = (ctx, reason) => { try { ctx.log?.(`travel ${reason}`); } catch {} };
export const DEFAULT_TZ = 'UTC';

// ---- time zones (Intl; airport zones come from AeroAPI origin/destination.timezone) --------------------------------
const formats = new Map();
function fmt(tz, opts, fallback) {
  const key = tz + JSON.stringify(opts);
  if (!formats.has(key)) {
    try { formats.set(key, new Intl.DateTimeFormat('en-US', { ...opts, timeZone: tz })); }
    catch { return tz === fallback ? new Intl.DateTimeFormat('en-US', opts) : fmt(fallback, opts, fallback); }
  }
  return formats.get(key);
}
export function localDate(t, tz = DEFAULT_TZ) {
  const p = Object.fromEntries(fmt(tz || DEFAULT_TZ, { year: 'numeric', month: '2-digit', day: '2-digit' }, DEFAULT_TZ).formatToParts(new Date(t)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
const clock = (t, tz, fallback = DEFAULT_TZ) => t === null ? '?' : fmt(tz || fallback, { hour: 'numeric', minute: '2-digit' }, fallback).format(new Date(t)).replace(/ /g, ' ');

// ---- input ----------------------------------------------------------------------------------------------------------
/** "UA123", "ua 123", "UAL123" -> {ident, iata, number, airlineName}. A bare number is 400 airline_required. */
export function parseIdent(input) {
  if (typeof input !== 'string' && typeof input !== 'number') throw httpError(400, 'ident_required');
  const s = String(input).toUpperCase().replace(/[\s-]+/g, '');
  if (!s) throw httpError(400, 'ident_required');
  if (/^\d{1,5}[A-Z]?$/.test(s)) throw httpError(400, 'airline_required');
  const m = /^([A-Z]{3})(\d{1,4}[A-Z]?)$/.exec(s) ?? /^([A-Z]{2}|[A-Z]\d|\d[A-Z])(\d{1,4}[A-Z]?)$/.exec(s);
  if (!m) throw httpError(400, 'invalid_ident');
  const iata = m[1].length === 2 ? m[1] : ICAO_TO_IATA[m[1]] ?? null;
  return { ident: s, iata, number: m[2], airlineName: iata ? AIRLINES[iata]?.[1] ?? null : null };
}
const validDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(Date.parse(s + 'T00:00:00Z') || 0).toISOString().slice(0, 10) === s;

// ---- settings -------------------------------------------------------------------------------------------------------
export function getSettings(ctx) {
  let doc = null; try { doc = ctx.store.get(TRAVEL_SETTINGS, 'settings'); } catch {}
  const s = { ...DEFAULT_SETTINGS, notify: { ...DEFAULT_SETTINGS.notify } };
  if (doc) {
    for (const k of Object.keys(s.notify)) if (typeof doc.notify?.[k] === 'boolean') s.notify[k] = doc.notify[k];
    for (const k of ['delayThresholdMin', 'minConnectMin', 'popupWindowH', 'boardingLeadMin']) if (typeof doc[k] === 'number' && Number.isFinite(doc[k])) s[k] = doc[k];
  }
  return s;
}
const LIMITS = { delayThresholdMin: [1, 240, true], minConnectMin: [0, 240, true], popupWindowH: [0, 48, false], boardingLeadMin: [10, 90, false] };
/** Partial merge; unknown keys and out-of-range values are 400 invalid_settings. */
export async function saveSettings(ctx, patch) {
  const bad = () => httpError(400, 'invalid_settings');
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw bad();
  const next = getSettings(ctx);
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'notify') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad();
      for (const [n, b] of Object.entries(v)) { if (!(n in next.notify) || typeof b !== 'boolean') throw bad(); next.notify[n] = b; }
    } else if (k === 'boardingLeadMin' && v === null) next[k] = null;
    else if (LIMITS[k]) {
      const [lo, hi, int] = LIMITS[k];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi || (int && !Number.isInteger(v))) throw bad();
      next[k] = v;
    } else throw bad();
  }
  ctx.store.put(TRAVEL_SETTINGS, { id: 'settings', ...next, updatedAt: iso(ctx.now()) });
  // A new boarding lead applies to the stored flights at once (status follows at their next poll).
  for (const f of all(ctx)) {
    const b = boardingOf(f.departure, f.status, boardingLead(next, f.airline?.iata));
    if (JSON.stringify(b) !== JSON.stringify(f.departure?.boarding ?? null)) ctx.store.put(TRAVEL_FLIGHTS, { ...f, departure: { ...f.departure, boarding: b } });
  }
  await ctx.store.flushed().catch(() => {});
  changed(ctx, { reason: 'settings' });
  return getSettings(ctx);
}

// ---- AeroAPI adapter ------------------------------------------------------------------------------------------------
class AeroError extends Error { constructor(reason, status) { super(reason); this.reason = reason; this.status = status; } }
async function aeroGet(ctx, key, path, signal) {
  let res;
  try { res = await ctx.fetch(AEROAPI + path, { headers: { 'x-apikey': key, Accept: 'application/json' }, redirect: 'error', signal: signal ?? AbortSignal.timeout(TIMEOUT_MS) }); }
  catch (e) { throw new AeroError(e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : 'network'); }
  if (res.status === 404) { res.body?.cancel?.().catch?.(() => {}); return null; }
  if (!res.ok) { res.body?.cancel?.().catch?.(() => {}); throw new AeroError(`provider_${res.status}`, res.status); }
  try { return await res.json(); } catch { throw new AeroError('bad_json'); }
}
export async function providerKey(ctx) {
  try { return str(await ctx.secret(AEROAPI_KEY, { optional: true })); }
  catch { log(ctx, 'secret_unavailable'); return null; }
}

/** The flight whose scheduled gate departure falls on `date` in its origin's time zone (a known fa_flight_id wins). */
export function pickFlight(list, date, faId, tz = DEFAULT_TZ) {
  const flights = (Array.isArray(list) ? list : []).filter(f => f && typeof f === 'object');
  if (faId) { const hit = flights.find(f => f.fa_flight_id === faId); if (hit) return hit; }
  const dep = (f) => ms(f.scheduled_out ?? f.scheduled_off);
  // Same-day multi-leg numbers (common on Southwest): the earliest leg that has not arrived yet; once one is picked its
  // fa_flight_id is stored and kept (above).
  const on = flights.filter(f => dep(f) !== null && localDate(dep(f), f.origin?.timezone || tz) === date).sort((a, b) => dep(a) - dep(b));
  return on.find(f => !f.actual_in) ?? on[0] ?? null;
}

const delayMin = (sec, t, sched) => typeof sec === 'number' && Number.isFinite(sec) ? Math.round(sec / 60) : t !== null && sched !== null ? Math.round((t - sched) / MIN) : 0;
/** AeroAPI flight -> Flight.status (AeroAPI has no boarding signal: boarding = gate departure minus leadMin). */
export function statusOf(f, now, leadMin = BOARDING_LEAD_MIN.default) {
  if (f.cancelled) return 'cancelled';
  if (f.diverted) return 'diverted';
  if (f.actual_in) return 'arrived';
  if (f.actual_on) return 'landed';
  if (f.actual_off) return 'en_route';
  if (f.actual_out) return 'departed';
  if (typeof f.progress_percent === 'number' && f.progress_percent > 0 && f.progress_percent < 100) return 'en_route';
  const dep = ms(f.estimated_out ?? f.scheduled_out ?? f.estimated_off ?? f.scheduled_off);
  if (dep === null) return 'unknown';
  if (now >= dep - leadMin * MIN) return dep > now - 3 * H ? 'boarding' : 'unknown';
  const sched = ms(f.scheduled_out ?? f.scheduled_off);
  return delayMin(f.departure_delay, dep, sched) >= 15 ? 'delayed' : 'scheduled';
}
const airport = (a) => ({ code: str(a?.code_iata) ?? str(a?.code) ?? str(a?.code_icao), city: str(a?.city), name: str(a?.name), tz: str(a?.timezone) });
const times = (s, e, a, sec) => ({ scheduled: iso(s), estimated: iso(e), actual: iso(a), delayMin: delayMin(sec, ms(a ?? e), ms(s)) });
const best = (t) => ms(t?.actual ?? t?.estimated ?? t?.scheduled);

/** Estimated boarding: gate departure (estimated, else scheduled) minus leadMin; null without a time or when cancelled/diverted. */
export function boardingOf(departure, status, leadMin) {
  const est = ms(departure?.estimated ?? departure?.scheduled), sched = ms(departure?.scheduled);
  if (est === null || status === 'cancelled' || status === 'diverted') return null;
  return { time: iso(est - leadMin * MIN), scheduledTime: sched === null ? null : iso(sched - leadMin * MIN), leadMin, estimated: true };
}
/** Flight fields from one AeroAPI flight (status text and polling are added by the caller). */
export function snapshot(f, now, leadMin = boardingLead(null, str(f.operator_iata))) {
  const status = statusOf(f, now, leadMin);
  const departure = { ...times(f.scheduled_out ?? f.scheduled_off, f.estimated_out ?? (f.scheduled_out ? null : f.estimated_off), f.actual_out, f.departure_delay), gate: str(f.gate_origin), terminal: str(f.terminal_origin) };
  departure.boarding = boardingOf(departure, status, leadMin);
  return {
    origin: airport(f.origin), destination: airport(f.destination),
    status, departure,
    arrival: { ...times(f.scheduled_in ?? f.scheduled_on, f.estimated_in ?? (f.scheduled_in ? null : f.estimated_on), f.actual_in, f.arrival_delay), gate: str(f.gate_destination), terminal: str(f.terminal_destination), baggage: str(f.baggage_claim) },
    progress: typeof f.progress_percent === 'number' ? f.progress_percent : null,
    landing: { scheduled: iso(f.scheduled_on), estimated: iso(f.estimated_on), actual: iso(f.actual_on) },
  };
}

export function statusText(fl, tz, now = null) {
  const o = fl.origin?.tz, d = fl.destination?.tz, dep = best(fl.departure);
  // Within 3 h of departure a scheduled/delayed flight leads with its estimated boarding time.
  const boards = now !== null && fl.departure?.boarding && dep !== null && dep - now <= 3 * H ? ms(fl.departure.boarding.time) : null;
  switch (fl.status) {
    case 'cancelled': return 'Cancelled';
    case 'diverted': return 'Diverted';
    case 'arrived': return `Arrived ${clock(ms(fl.arrival.actual), d, tz)}${fl.arrival.baggage ? `, baggage claim ${fl.arrival.baggage}` : ''}`;
    case 'landed': return `Landed ${clock(ms(fl._?.landing?.actual ?? fl.arrival.estimated), d, tz)}`;
    case 'en_route': return `En route, lands ${clock(ms(fl._?.landing?.estimated ?? fl._?.landing?.scheduled ?? fl.arrival.estimated ?? fl.arrival.scheduled), d, tz)}`;
    case 'departed': return `Departed ${clock(ms(fl.departure.actual), o, tz)}`;
    case 'boarding': return `Boarding${fl.departure.gate ? ` at gate ${fl.departure.gate}` : ''}, departs ${clock(dep, o, tz)}`;
    case 'delayed': return boards !== null ? `Delayed ${fl.departure.delayMin} min, boards ${clock(boards, o, tz)}` : `Delayed ${fl.departure.delayMin} min, departs ${clock(dep, o, tz)}`;
    case 'scheduled': return boards !== null ? `Boards ${clock(boards, o, tz)}${fl.departure.gate ? `, gate ${fl.departure.gate}` : ''}` : `On time, departs ${clock(dep, o, tz)}`;
    default: return fl.error === 'no_provider' ? 'No flight data provider' : fl.error === 'not_found' ? 'Flight not found for that date'
      : fl.error === 'provider_error' ? 'Flight data unavailable' : fl._?.early ? 'Tracking starts 2 days before' : 'Waiting for flight data';
  }
}

// ---- polling cadence ------------------------------------------------------------------------------------------------
const dayStart = (date) => Date.parse(date + 'T00:00:00Z');
/** When a flight is next fetched after a poll at `now` (null = never again). See docs/spec.md "Poller". */
export function nextPollAt(fl, now, prevStatus) {
  const arrRef = best(fl.arrival) ?? (dayStart(fl.date) + D + 12 * H);
  if (fl.status === 'cancelled' || fl.status === 'diverted') {
    const end = (ms(fl.arrival.scheduled) ?? arrRef) + 6 * H;
    return now < end ? now + 15 * MIN : null;
  }
  if (fl.status === 'arrived') return prevStatus === 'arrived' ? null : now + 5 * MIN; // one last poll, then stop
  if (now > arrRef + 12 * H) return null; // stale data (never arrived): give up
  if (fl.status === 'landed') { // no gate arrival yet: 5 min for an hour, then 30 min, give up 2 h after touchdown
    const on = ms(fl._?.landing?.actual) ?? now;
    return now - on >= 2 * H ? null : now - on >= H ? now + 30 * MIN : now + 5 * MIN;
  }
  if (['departed', 'en_route'].includes(fl.status)) return now + 5 * MIN;
  const dep = best(fl.departure) ?? (dayStart(fl.date) + 12 * H), t = dep - now;
  if (t > 24 * H) return Math.min(now + 3 * H, dep - 24 * H);
  if (t > 6 * H) return Math.min(now + 30 * MIN, dep - 6 * H);
  return now + 5 * MIN;
}

// ---- connections ----------------------------------------------------------------------------------------------------
const CONN_RANK = { ok: 0, tight: 1, at_risk: 2, missed: 3 };
const classify = (layoverMin, min) => layoverMin < 0 ? 'missed' : layoverMin >= min + 15 ? 'ok' : layoverMin >= min ? 'tight' : 'at_risk';
/** Connections between tracked flights: B leaves A's destination 0-24 h after A's scheduled arrival. */
export function connections(flights, settings = DEFAULT_SETTINGS, { all: keepCancelled = false } = {}) {
  const out = [], min = settings.minConnectMin;
  for (const a of flights) for (const b of flights) {
    if (a === b || a.id === b.id || !a.destination?.code || a.destination.code !== b.origin?.code) continue;
    const aSched = ms(a.arrival?.scheduled), bSched = ms(b.departure?.scheduled);
    if (aSched === null || bSched === null || bSched - aSched < 0 || bSched - aSched > 24 * H) continue;
    if (!keepCancelled && (['cancelled', 'diverted'].includes(a.status) || ['cancelled', 'diverted'].includes(b.status))) continue;
    const layoverMin = Math.round((best(b.departure) - best(a.arrival)) / MIN);
    const leftFirst = b.departure.actual && !(a.arrival.actual && ms(a.arrival.actual) <= ms(b.departure.actual));
    const status = leftFirst ? 'missed' : classify(layoverMin, min);
    const gates = a.arrival.gate || b.departure.gate ? `, gate ${a.arrival.gate ?? '?'} -> ${b.departure.gate ?? '?'}` : '';
    const text = status === 'missed' ? `Missed connection in ${a.destination.code}${gates}` : `${layoverMin} min in ${a.destination.code}${gates}`;
    out.push({ fromId: a.id, toId: b.id, airport: a.destination.code, layoverMin, minConnectMin: min, status, text });
  }
  return out.sort((x, y) => (ms(flights.find(f => f.id === x.fromId)?.arrival?.scheduled) ?? 0) - (ms(flights.find(f => f.id === y.fromId)?.arrival?.scheduled) ?? 0));
}

// ---- flights in the store -------------------------------------------------------------------------------------------
export const publicFlight = ({ _, createdAt, ...f }) => f;
const all = (ctx) => { try { return ctx.store.all(TRAVEL_FLIGHTS); } catch { return []; } };
const getDoc = (ctx, c, id) => { try { return ctx.store.get(c, id); } catch { return null; } };
const refEnd = (f) => best(f.arrival) ?? (dayStart(f.date) + D + 12 * H);
const hidden = (f, now) => refEnd(f) + 12 * H < now;
const changed = (ctx, data) => { try { ctx.events?.publish('travel', data, { supersede: true }); } catch {} };
const tzOf = (ctx) => ctx.config?.tz || DEFAULT_TZ;
const depSort = (f) => ms(f.departure?.scheduled) ?? (dayStart(f.date) + 12 * H);
const visible = (ctx, now) => all(ctx).filter(f => !hidden(f, now)).sort((a, b) => depSort(a) - depSort(b));

function dropNotified(ctx, id) {
  try {
    ctx.store.del(TRAVEL_NOTIFIED, id);
    for (const d of ctx.store.all(TRAVEL_NOTIFIED)) if (d.id.startsWith('conn:') && d.id.slice(5).split('>').includes(id)) ctx.store.del(TRAVEL_NOTIFIED, d.id);
  } catch {}
}
/** Deletes flights 3 days after arrival (they leave the list 12 h after arrival). */
export function pruneFlights(ctx) {
  const now = ctx.now(); let n = 0;
  for (const f of all(ctx)) if (refEnd(f) + 3 * D < now) { ctx.store.del(TRAVEL_FLIGHTS, f.id); dropNotified(ctx, f.id); n++; }
  return n;
}

export async function travelView(ctx, { key } = {}) {
  pruneFlights(ctx);
  if (key === undefined) key = await providerKey(ctx);
  const now = ctx.now(), settings = getSettings(ctx);
  const tz = tzOf(ctx);
  const flights = visible(ctx, now).map(f => key ? { ...f, statusText: statusText(f, tz, now) } : { ...f, error: 'no_provider', statusText: f.status === 'unknown' ? 'No flight data provider' : statusText(f, tz, now) });
  return { flights: flights.map(publicFlight), connections: connections(flights, settings), settings, provider: { name: 'aeroapi', configured: !!key }, updatedAt: iso(now) };
}

function blank(ctx, p, date, label) {
  const now = ctx.now();
  const empty = { code: null, city: null, name: null, tz: null }, t = { scheduled: null, estimated: null, actual: null, delayMin: 0 };
  return { id: `${p.ident}-${date}`, ident: p.ident, label, date, airline: { iata: p.iata, name: p.airlineName }, number: p.number,
    origin: { ...empty }, destination: { ...empty }, status: 'unknown', statusText: 'Waiting for flight data',
    departure: { ...t, gate: null, terminal: null, boarding: null }, arrival: { ...t, gate: null, terminal: null, baggage: null },
    progress: null, inbound: null, polledAt: null, nextPollAt: iso(now), error: null, createdAt: iso(now), _: {} };
}

/** POST /travel/flights and travel_add_flight. Duplicate ident + date returns the existing flight. */
export async function addFlight(ctx, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'ident_required');
  const p = parseIdent(body.ident);
  const date = body.date === undefined || body.date === null || body.date === '' ? localDate(ctx.now(), tzOf(ctx)) : body.date;
  if (!validDate(date)) throw httpError(400, 'invalid_date');
  const day = dayStart(date), now = ctx.now();
  if (day + D < now - 2 * D || day > now + 366 * D) throw httpError(400, 'invalid_date');
  if (body.label !== undefined && body.label !== null && typeof body.label !== 'string') throw httpError(400, 'invalid_label');
  const label = str(body.label)?.slice(0, 80) ?? null;
  const id = `${p.ident}-${date}`, existing = getDoc(ctx, TRAVEL_FLIGHTS, id);
  if (existing) return publicFlight(existing);
  ctx.store.put(TRAVEL_FLIGHTS, blank(ctx, p, date, label));
  // Poll once now, best effort within 8 s (a slow provider leaves the flight to the poller).
  let timer;
  try {
    await Promise.race([pollFlight(ctx, id, { signal: AbortSignal.timeout(TIMEOUT_MS) }), new Promise(r => { timer = setTimeout(r, TIMEOUT_MS); timer.unref?.(); })]);
  } catch { /* logged in pollFlight */ } finally { clearTimeout(timer); }
  await ctx.store.flushed().catch(() => {});
  changed(ctx, { reason: 'added', flightId: id });
  return publicFlight(getDoc(ctx, TRAVEL_FLIGHTS, id) ?? blank(ctx, p, date, label));
}
export async function removeFlight(ctx, id) {
  const had = typeof id === 'string' && ctx.store.del(TRAVEL_FLIGHTS, id);
  if (had) { dropNotified(ctx, id); await ctx.store.flushed().catch(() => {}); changed(ctx, { reason: 'removed', flightId: id }); }
  return had;
}
/** POST /travel/refresh: polls every active flight now, then answers like GET /travel. */
export async function refreshAll(ctx) {
  const key = await providerKey(ctx), now = ctx.now();
  const active = visible(ctx, now).filter(f => f.nextPollAt !== null || f.error === 'no_provider' || f.status === 'unknown');
  await Promise.all(active.map(f => pollFlight(ctx, f.id, { key, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => null)));
  return travelView(ctx, { key });
}

// ---- one poll ---------------------------------------------------------------------------------------------------------
const inflight = new WeakMap();
/** Fetches one flight (if due or forced), stores the new snapshot, notifies changes. Concurrent calls share one poll. */
export function pollFlight(ctx, id, opts = {}) {
  let map = inflight.get(ctx); if (!map) inflight.set(ctx, map = new Map());
  if (map.has(id)) return map.get(id);
  const job = doPoll(ctx, id, opts).finally(() => map.delete(id));
  map.set(id, job);
  return job;
}

async function doPoll(ctx, id, { key, signal } = {}) {
  const old = getDoc(ctx, TRAVEL_FLIGHTS, id);
  if (!old) return null;
  if (key === undefined) key = await providerKey(ctx);
  const now = ctx.now(), tz = tzOf(ctx), state = { ...(old._ ?? {}) };
  // A flight deleted while this poll awaited the provider stays deleted (no resurrection, no notification).
  const save = (fl) => { if (!getDoc(ctx, TRAVEL_FLIGHTS, id)) return null; fl.statusText = statusText(fl, tz, now); return ctx.store.put(TRAVEL_FLIGHTS, fl); };
  if (!key) return save({ ...old, error: 'no_provider', nextPollAt: null, _: state });

  const day = dayStart(old.date), wantEnd = day + D + 12 * H;
  const start = Math.max(day - 14 * H, now - LOOKBACK_MS), end = Math.min(wantEnd, now + HORIZON_MS);
  if (start >= end) {
    if (day - 14 * H <= now) return save({ ...old, error: 'not_found', nextPollAt: null, _: state });
    // Beyond AeroAPI's look-ahead: no call until the departure day enters it.
    return save({ ...old, error: null, nextPollAt: iso(Math.max(day - 14 * H - HORIZON_MS, now + 5 * MIN)), _: { ...state, early: true } });
  }

  let raw;
  try {
    const data = await aeroGet(ctx, key, `/flights/${encodeURIComponent(old.ident)}?start=${aeroTime(start)}&end=${aeroTime(end)}`, signal);
    raw = pickFlight(data?.flights, old.date, state.faId, tz);
  } catch (e) {
    log(ctx, e instanceof AeroError ? e.reason : 'failed');
    const normal = (nextPollAt(old, now, state.lastStatus) ?? now + 5 * MIN) - now;
    const backoffMs = normal >= H ? normal : Math.min(H, 2 * (state.backoffMs || normal));
    return save({ ...old, error: 'provider_error', polledAt: old.polledAt, nextPollAt: iso(now + backoffMs), _: { ...state, backoffMs } });
  }
  if (!raw) {
    const early = end < wantEnd; // part of the departure day is still beyond the look-ahead
    return save({ ...old, error: early ? null : 'not_found', polledAt: iso(now), nextPollAt: now < wantEnd + 12 * H ? iso(now + 3 * H) : null, _: { ...state, early, backoffMs: 0 } });
  }

  const snap = snapshot(raw, now, boardingLead(getSettings(ctx), str(raw.operator_iata) ?? old.airline?.iata));
  const { landing } = snap; delete snap.landing;
  // The inbound aircraft gives an early delay warning: fetched only inside 6 h of departure, before pushback, at most
  // every 20 min, and never again once it has landed (a different inbound aircraft is fetched at once).
  let inbound = old.inbound ?? null, inboundAt = state.inboundAt ?? null;
  const dep = best(snap.departure), ibId = raw.inbound_fa_flight_id ?? null, sameIb = ibId && ibId === state.inboundId;
  if (ibId && !raw.actual_out && dep !== null && dep - now <= 6 * H &&
      !(sameIb && (['landed', 'arrived'].includes(inbound?.status) || (ms(inboundAt) !== null && now - ms(inboundAt) < 20 * MIN)))) {
    try {
      const ib = (await aeroGet(ctx, key, `/flights/${encodeURIComponent(ibId)}`, signal))?.flights?.[0];
      inboundAt = iso(now);
      if (ib) inbound = { ident: str(ib.ident_iata) ?? str(ib.ident), status: statusOf(ib, now), delayMin: delayMin(ib.arrival_delay, ms(ib.actual_in ?? ib.estimated_in), ms(ib.scheduled_in)) };
    } catch (e) { log(ctx, `inbound ${e instanceof AeroError ? e.reason : 'failed'}`); }
  }
  const iata = str(raw.operator_iata) ?? old.airline?.iata ?? null;
  const fl = { ...old, ...snap, inbound, error: null, polledAt: iso(now),
    airline: { iata, name: (iata && AIRLINES[iata]?.[1]) ?? old.airline?.name ?? null },
    number: str(raw.flight_number) ?? old.number,
    _: { ...state, faId: raw.fa_flight_id ?? state.faId ?? null, landing, backoffMs: 0, early: false, lastStatus: snap.status, inboundId: ibId ?? state.inboundId ?? null, inboundAt } };
  fl.nextPollAt = iso(nextPollAt(fl, now, state.lastStatus));
  const doc = save(fl);
  if (!doc) return null;
  notifyChanges(ctx, doc, now);
  await ctx.store.flushed().catch(() => {});
  changed(ctx, { reason: 'polled', flightId: id });
  return doc;
}

// ---- notifications (docs/spec.md rubric) --------------------------------------------------------------------------
const MILESTONE = { departed: 1, en_route: 1, landed: 2, arrived: 3 };
const LIVE = ['scheduled', 'delayed', 'boarding'];
const RECOVER_MARGIN_MIN = 5, REPOPUP_MS = 30 * MIN;
/** Hysteresis: a connection only recovers once its layover is RECOVER_MARGIN_MIN past the boundary it crossed. */
export function connectionStatus(c, stored) {
  if (!stored || !(stored in CONN_RANK) || CONN_RANK[c.status] >= CONN_RANK[stored]) return c.status;
  const margin = classify(c.layoverMin - RECOVER_MARGIN_MIN, c.minConnectMin);
  return CONN_RANK[margin] >= CONN_RANK[stored] ? stored : margin;
}
// The popup window opens at the earlier of the scheduled and current departure (a big delay must not hide it).
const windowStart = (f) => { const a = ms(f?.departure?.scheduled), b = best(f?.departure); return a === null ? b : b === null ? a : Math.min(a, b); };
const inWindowOf = (f, s, now) => { const t = windowStart(f); return t !== null && t - now <= s.popupWindowH * H && f.status !== 'arrived'; };

/**
 * Diffs a fresh snapshot against the last notified state; changes merge into one notification. Synchronous.
 * A flight's first data (and a connection's first appearance) is compared with an unremarkable baseline (on time,
 * connection ok), so a flight that is already cancelled, delayed or badly connected is announced at once.
 */
export function notifyChanges(ctx, fl, now = ctx.now()) {
  if (fl.status === 'unknown') return null;
  const s = getSettings(ctx), tz = tzOf(ctx), items = [], th = s.delayThresholdMin;
  const o = fl.origin.tz, d = fl.destination.tz, dep = best(fl.departure);
  const depLine = () => `Departs ${clock(dep, o, tz)}${fl.departure.gate ? ` from gate ${fl.departure.gate}` : ''}.`;
  const inWindow = inWindowOf(fl, s, now);
  const flights = visible(ctx, now);
  const conns = connections(flights, s);
  const stored = getDoc(ctx, TRAVEL_NOTIFIED, fl.id);
  const milestone = MILESTONE[fl.status] ?? 0;
  const prev = stored ?? { status: 'scheduled', delayMin: 0, gate: fl.departure.gate, terminal: fl.departure.terminal,
    boarding: fl.status === 'boarding' || milestone > 0, milestone };
  const next = { ...prev, id: fl.id, status: fl.status, at: iso(now) };

  if ((fl.status === 'cancelled' || fl.status === 'diverted') && prev.status !== fl.status) {
    const affected = connections(flights, s, { all: true }).filter(c => c.fromId === fl.id || c.toId === fl.id).map(c => {
      const other = flights.find(f => f.id === (c.fromId === fl.id ? c.toId : c.fromId));
      return other ? `Connection ${c.fromId === fl.id ? 'to' : 'from'} ${other.ident} in ${c.airport} affected.` : '';
    });
    items.push({ score: 100, popup: true, title: `${fl.ident} ${fl.status}`, line: `${fl.status === 'cancelled' ? 'Cancelled' : 'Diverted'}.`,
      detail: [`${fl.origin.code ?? '?'} -> ${fl.destination.code ?? '?'}, was due to depart ${clock(ms(fl.departure.scheduled), o, tz)}.`, ...affected].filter(Boolean).join(' ') });
  }
  if (LIVE.includes(fl.status)) {
    const delay = fl.departure.delayMin, was = prev.delayMin ?? 0;
    if (Math.abs(delay - was) >= th && (Math.abs(delay) >= th || Math.abs(was) >= th)) {
      next.delayMin = delay;
      if (s.notify.delays) {
        const [title, line] = Math.abs(delay) < th ? [`${fl.ident} back on time`, 'Now on time.']
          : delay <= -th ? [`${fl.ident} departs ${-delay} min early`, `Departs ${-delay} min early.`]
          : [`${fl.ident} delayed ${delay} min`, `Delayed ${delay} min.`];
        const boards = inWindow && fl.departure.boarding ? ` Boards ~${clock(ms(fl.departure.boarding.time), o, tz)}.` : '';
        items.push({ score: 80, popup: inWindow, title, detail: `${line} ${depLine()}${boards}`, line });
      }
    }
    const g = fl.departure.gate, t = fl.departure.terminal;
    const gateMoved = prev.gate && g && g !== prev.gate, termMoved = prev.terminal && t && t !== prev.terminal;
    if ((gateMoved || termMoved) && s.notify.gates) {
      const where = [termMoved ? `terminal ${t}` : null, g ? `gate ${g}` : null].filter(Boolean).join(', ');
      const was2 = [termMoved ? `terminal ${prev.terminal}` : null, gateMoved ? `gate ${prev.gate}` : null].filter(Boolean).join(', ');
      items.push({ score: 60, popup: inWindow, title: `${fl.ident} now ${where}`, detail: `Was ${was2}. Departs ${clock(dep, o, tz)}.`, line: `Now ${where} (was ${was2}).` });
    }
    if (g) next.gate = g; if (t) next.terminal = t;
  }
  if (fl.status === 'boarding' && !prev.boarding) {
    next.boarding = true;
    if (s.notify.departures) items.push({ score: 70, popup: true, title: `${fl.ident} boarding`, detail: `Boarding now${fl.departure.gate ? ` at gate ${fl.departure.gate}` : ''}. Departs ${clock(dep, o, tz)}.`, line: 'Boarding.' });
  }
  if (milestone > (prev.milestone ?? 0)) {
    next.milestone = milestone; next.boarding = true;
    if (milestone === 1 && s.notify.departures) {
      items.push({ score: 20, popup: false, title: `${fl.ident} departed ${fl.origin.code ?? ''}`.trim(), line: 'Departed.',
        detail: `Lands ${clock(ms(fl._?.landing?.estimated ?? fl.arrival.estimated ?? fl.arrival.scheduled), d, tz)}${fl.destination.code ? ` in ${fl.destination.code}` : ''}.` });
    } else if (milestone >= 2 && s.notify.arrivals) {
      const onward = conns.filter(c => c.fromId === fl.id).map(c => {
        const b = flights.find(f => f.id === c.toId);
        return b ? `Connection ${b.ident}${b.departure.gate ? ` at gate ${b.departure.gate}` : ''}, departs ${clock(best(b.departure), b.origin.tz, tz)}.` : '';
      });
      const detail = [fl.arrival.gate ? `Gate ${fl.arrival.gate}.` : '', fl.arrival.baggage ? `Baggage claim ${fl.arrival.baggage}.` : '', ...onward].filter(Boolean).join(' ');
      items.push({ score: 20, popup: false, line: milestone === 3 ? 'Arrived.' : 'Landed.', detail,
        title: milestone === 3 ? `${fl.ident} arrived${fl.arrival.gate ? ` at gate ${fl.arrival.gate}` : fl.destination.code ? ` in ${fl.destination.code}` : ''}` : `${fl.ident} landed${fl.destination.code ? ` in ${fl.destination.code}` : ''}` });
    }
  }
  ctx.store.put(TRAVEL_NOTIFIED, next);

  for (const c of conns.filter(c => c.fromId === fl.id || c.toId === fl.id)) {
    const cid = `conn:${c.fromId}>${c.toId}`, pc = getDoc(ctx, TRAVEL_NOTIFIED, cid);
    const was = pc?.status ?? 'ok', status = connectionStatus(c, was), announced = { ...(pc?.announced ?? {}) };
    const doc = { id: cid, status, layoverMin: c.layoverMin, announced, at: iso(now) };
    if (status !== was && s.notify.connection) {
      const worse = CONN_RANK[status] > CONN_RANK[was];
      const a = flights.find(f => f.id === c.fromId);
      // A first sighting of a merely tight connection streams; worsening pops up inside the earlier flight's window.
      const popup = worse && inWindowOf(a, s, now) && !(!pc && status === 'tight');
      const recent = worse && ms(announced[status]) !== null && now - ms(announced[status]) < REPOPUP_MS;
      if (!recent) {
        if (worse) announced[status] = iso(now);
        const label = status === 'missed' ? 'missed' : `now ${c.layoverMin} min (${status.replace('_', ' ')})`;
        items.push({ score: worse ? 75 : 15, popup, line: `Connection in ${c.airport} ${label}.`, detail: `${c.text}.`,
          title: worse ? (status === 'missed' ? `Connection missed in ${c.airport}` : status === 'tight' ? `Tight connection in ${c.airport}` : `Connection at risk in ${c.airport}`) : `Connection in ${c.airport} OK again` });
      }
    }
    ctx.store.put(TRAVEL_NOTIFIED, doc);
  }
  if (!items.length) return null;
  items.sort((a, b) => b.score - a.score);
  const [top, ...rest] = items, popup = items.some(i => i.popup);
  const body = [top.detail, ...rest.map(i => i.line)].filter(Boolean).join(' ').slice(0, 1000);
  const row = ctx.store.put('notifications', { id: `travel:${fl.id}:${now}`, source: 'Travel', title: top.title.slice(0, 200), body,
    importance: popup ? 0.9 : 0.5, icon: 'plane', route: popup ? 'popup' : 'stream', reason: 'travel',
    open: { screen: 'travel', flightId: fl.id, args: { flightId: fl.id } }, flightId: fl.id, createdAt: iso(now) });
  ctx.events?.publish('notification', row);
  return row;
}

// ---- worker poller --------------------------------------------------------------------------------------------------
/** Ticks every 60 s (worker only) and polls each flight whose nextPollAt has passed. */
export function createTravelPoller(ctx, { everyMs = Number(ctx.config?.travelTickMs) > 0 ? Number(ctx.config.travelTickMs) : 60000 } = {}) {
  let timer = null, first = null, running = false;
  async function tick() {
    if (running) return 0;
    running = true; let n = 0;
    try {
      pruneFlights(ctx);
      const key = await providerKey(ctx);
      if (!key) return 0;
      const now = ctx.now();
      const due = all(ctx).filter(f => !hidden(f, now) && (f.error === 'no_provider' || (f.nextPollAt && ms(f.nextPollAt) <= now)));
      for (const f of due) { await pollFlight(ctx, f.id, { key }).catch(() => log(ctx, 'poll_failed')); n++; }
    } catch { log(ctx, 'tick_failed'); } finally { running = false; }
    return n;
  }
  return {
    tick,
    start() { if (timer) return; timer = setInterval(tick, everyMs); timer.unref?.(); first = setTimeout(tick, Math.min(everyMs, 5000)); first.unref?.(); },
    stop() { clearInterval(timer); clearTimeout(first); timer = first = null; },
  };
}
