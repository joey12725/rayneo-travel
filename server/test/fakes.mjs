// Tiny in-memory stand-ins for the host's document store and event bus (the engine's ctx.store / ctx.events).
import { randomUUID } from 'node:crypto';

/** all(c), get(c, id), put(c, doc) -> stored doc, del(c, id) -> bool, flushed(). Docs are copied on write. */
export function fakeStore() {
  const cols = new Map();
  const col = (c) => { if (!cols.has(c)) cols.set(c, new Map()); return cols.get(c); };
  return {
    all: (c) => [...col(c).values()],
    get: (c, id) => col(c).get(id) ?? null,
    put(c, doc) { const id = doc.id ?? randomUUID(), m = col(c); m.delete(id); m.set(id, { ...doc, id }); return m.get(id); },
    del: (c, id) => col(c).delete(id),
    async flushed() {},
  };
}

/** publish(type, data, {supersede}) and since(seq); events live in the store, so a "restart" on the same store keeps them. */
export function fakeEvents(store, { now = Date.now } = {}) {
  let seq = Math.max(0, ...store.all('events').map(e => e.seq || 0));
  return {
    publish(type, data = {}, { supersede = false } = {}) {
      if (supersede) for (const old of store.all('events')) if (old.type === type) store.del('events', old.eventId);
      const eventId = randomUUID(), ev = { ...data, seq: ++seq, type, at: new Date(now()).toISOString() };
      store.put('events', { ...ev, id: eventId, eventId });
      return ev;
    },
    since: (cursor = 0) => store.all('events').filter(e => e.seq > cursor).sort((a, b) => a.seq - b.seq).map(({ id, eventId, ...e }) => e),
  };
}

/** A router like the host's: r.get/post/put/del(path, handler, opts); call(method, path, body) runs the handler. */
export function fakeRouter() {
  const routes = [];
  const add = (method) => (pattern, handler, opts) => routes.push({ method, pattern, handler, opts });
  const r = { get: add('GET'), post: add('POST'), put: add('PUT'), del: add('DELETE'), routes };
  r.call = async (method, path, body) => {
    for (const route of routes) {
      if (route.method !== method) continue;
      const names = [], re = new RegExp('^' + route.pattern.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '$');
      const m = re.exec(path); if (!m) continue;
      const params = Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
      const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
      const req = (async function* () { if (text) yield Buffer.from(text); })();
      try { return { status: 200, value: await route.handler({ req, params }) }; }
      catch (e) { if (typeof e?.status !== 'number') throw e; return { status: e.status, value: { error: e.message } }; }
    }
    return { status: 404, value: { error: 'not_found' } };
  };
  return r;
}
