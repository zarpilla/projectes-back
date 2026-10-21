'use strict';

/**
 * The backend's read cache (issues/307).
 *
 * `get(key, loader, { tables })` answers from memory when it can and runs the
 * loader when it can't. What a kept result depends on is decided by what its
 * load did, not only by what the caller declares: every table the loader read
 * (seen by the hook on the MySQL connections) is added to `tables`. The result
 * is served again only while none of those tables changed since its load
 * began (change-tracker.js), and, for writes from outside this process, while
 * MySQL's stamps of those tables haven't moved (table-stamps.js).
 *
 * What is never kept:
 *   - a result whose tables changed while it was loading (it is still
 *     returned to its caller, like any uncached read);
 *   - a load that wrote something, read no known table, or read a table the
 *     tracker doesn't know;
 *   - anything read inside a transaction (the cache is skipped there: the
 *     transaction may see its own uncommitted writes or an older snapshot);
 *   - a result that can't be copied, or is larger than a quarter of the cap.
 * When change detection itself fails, nothing is served from memory.
 *
 * Callers never share objects with the cache: the kept value is a private copy,
 * and each answer is a fresh copy of it. For big read-only datasets, where a
 * copy per answer costs too much, `frozen: true` deep-freezes the result once
 * and hands the same object to every caller (also when the cache is off or
 * skipped, so code that changes it fails the same way everywhere: a TypeError
 * in strict mode).
 *
 * Requests that miss together share one load, but only if nothing they depend
 * on changed while it ran; otherwise each loads for itself.
 *
 * Memory is capped (bytes of the JSON form, least recently used first out),
 * and every entry also expires after `ttlMs` as a last safety net.
 *
 * `verifyRate` (0..1): that share of hits is loaded again and compared with
 * what was kept. A difference drops the entry; if the stamps then report a
 * write from outside on its tables it was the normal few seconds of delay for
 * those (warning), otherwise it is logged as an error: proof that a write went
 * unnoticed.
 */

const MB = 1024 * 1024;

const copy = (value) => structuredClone(value);

/**
 * The approximate size of a value in its JSON form (strings, numbers, keys),
 * walked without building the JSON. With `freeze`, also freezes everything it
 * holds. Throws for what can be neither frozen nor sized: buffers, Maps, Sets.
 * Memory in the heap is about 2–3 times this (measured: 18 MB of JSON → 48 MB).
 */
function measure(value, freeze = false) {
  let bytes = 0;
  const seen = new WeakSet();
  const stack = [value];
  while (stack.length) {
    const v = stack.pop();
    if (v === null || v === undefined) {
      bytes += 4;
      continue;
    }
    const type = typeof v;
    if (type === 'string') {
      bytes += v.length + 2;
      continue;
    }
    if (type !== 'object') {
      bytes += 8;
      continue;
    }
    if (seen.has(v)) continue;
    seen.add(v);
    if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer || v instanceof Map || v instanceof Set) {
      throw new TypeError('read-cache: results hold plain data only (no buffers, Maps or Sets)');
    }
    if (freeze) Object.freeze(v);
    if (v instanceof Date) {
      bytes += 26;
      continue;
    }
    bytes += 2;
    if (Array.isArray(v)) {
      bytes += v.length;
      for (let i = 0; i < v.length; i++) stack.push(v[i]);
    } else {
      for (const key of Object.keys(v)) {
        bytes += key.length + 4;
        stack.push(v[key]);
      }
    }
  }
  return bytes;
}

/**
 * JSON with the keys of every object sorted (array order kept): two answers
 * with the same data compare equal even if their keys came in another order.
 * Strapi fills populated relations with parallel queries, so the key order of
 * a row changes from one load to the next (measured on contacts/basic).
 */
function canonicalJson(value) {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (typeof value.toJSON === 'function') return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined && typeof value[k] !== 'function')
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/** Where two values first differ, for the STALE log: `data[2].name: "a" ≠ "b"`. */
function firstDifference(kept, fresh, path = '') {
  const show = (v) => {
    const text = JSON.stringify(v);
    return text === undefined ? String(v) : text.length > 80 ? `${text.slice(0, 80)}…` : text;
  };
  if (canonicalJson(kept) === canonicalJson(fresh)) return null;
  const isObject = (v) => v !== null && typeof v === 'object' && !(v instanceof Date);
  if (!isObject(kept) || !isObject(fresh) || Array.isArray(kept) !== Array.isArray(fresh)) {
    return `${path || '(root)'}: kept ${show(kept)} ≠ now ${show(fresh)}`;
  }
  if (Array.isArray(kept) && kept.length !== fresh.length) {
    return `${path || '(root)'}: kept ${kept.length} items ≠ now ${fresh.length}`;
  }
  for (const k of new Set([...Object.keys(kept), ...Object.keys(fresh)])) {
    const at = Array.isArray(kept) ? `${path}[${k}]` : path ? `${path}.${k}` : k;
    const found = firstDifference(kept[k], fresh[k], at);
    if (found) return found;
  }
  return `${path || '(root)'}: differs`;
}

/**
 * The report a key belongs to, for the per-report figures: a dataset's prefix
 * ('treasury.forecast:projects' → 'treasury.forecast'), or a route's method
 * and path ('route|GET /projects/basic|…' → 'GET /projects/basic').
 */
function familyOf(key) {
  const text = String(key);
  if (text.startsWith('route|')) return text.split('|')[1] || 'route';
  return text.split(':')[0];
}

// keys remembered to tell a first load from a load again (bounded: the
// queries of a cached route can vary without end)
const MAX_LOADED_KEYS = 5000;

const deepFreeze = (value) => {
  measure(value, true);
  return value;
};

class ReadCache {
  constructor({
    tracker,
    stamps = null,
    maxBytes = 64 * MB,
    ttlMs = 10 * 60 * 1000,
    verifyRate = 0,
    clock = Date.now,
    random = Math.random,
    inTransaction = () => false,
    log = null,
    slowLoadMs = 1000,
  }) {
    this.tracker = tracker;
    this.stamps = stamps;
    this.maxBytes = maxBytes;
    this.ttlMs = ttlMs;
    this.verifyRate = verifyRate;
    this.clock = clock;
    this.random = random;
    this.inTransaction = inTransaction;
    this.log = log;
    // per report: what its users got from memory and what they waited for
    // (issues/307: to decide whether warming the cache is worth it)
    this.startedAt = clock();
    this.slowLoadMs = slowLoadMs;
    this.reports = new Map(); // family -> figures
    this.loadedKeys = new Set();
    this.confirmWaitMs = 3100; // the 2 s recheck of recent stamps, and a margin
    this.confirming = null; // the last confirmMismatch (tests)
    this.enabled = false;
    this.entries = new Map(); // key -> entry, least recently used first
    this.byTable = new Map(); // table -> keys
    this.loading = new Map(); // key -> shared load
    this.bytes = 0;
    this.counts = {
      hits: 0,
      misses: 0,
      shared: 0,
      stored: 0,
      bypassed: 0,
      dropped: 0,
      evicted: 0,
      verified: 0,
      mismatches: 0,
      late: 0,
      stampFailures: 0,
      notStored: {},
      invalid: {},
    };
    this.unsubscribe = tracker.onChange((tables) => this.dropChanged(tables));
  }

  /** True when results may be served from memory. */
  isOn() {
    return this.enabled && !this.tracker.failure;
  }

  enable() {
    this.enabled = true;
  }

  disable() {
    this.enabled = false;
    this.clear('disabled');
  }

  /**
   * @template T
   * @param {string} key everything the result depends on besides the tables
   * @param {() => Promise<T>} loader
   * @param {{ tables?: string[], ttlMs?: number, keep?: (value: T) => boolean, frozen?: boolean, maxBytes?: number, verifyRate?: number }} [options]
   *   tables: what the result depends on beyond what the loader reads
   *   keep: false for a result that must not be kept (an error page...)
   *   frozen: one deep-frozen object shared by every caller instead of copies
   *   maxBytes: the largest result kept (default a quarter of the cap, never more than the cap)
   *   verifyRate: this call's share of hits verified (default the cache's)
   * @returns {Promise<T>}
   */
  async get(key, loader, options = {}) {
    if (!this.isOn() || this.inTransaction()) {
      this.counts.bypassed++;
      if (!options.frozen) return loader();
      const value = await loader();
      try {
        return deepFreeze(value);
      } catch {
        return value;
      }
    }
    const answer = (value) => (options.frozen ? value : copy(value));
    const verifyRate = options.verifyRate === undefined ? this.verifyRate : options.verifyRate;

    const entry = this.entries.get(key);
    if (entry) {
      let invalid;
      try {
        invalid = await this.whyInvalid(entry);
      } catch (error) {
        return this.withoutStamps(error, loader);
      }
      if (invalid) this.counts.invalid[invalid] = (this.counts.invalid[invalid] || 0) + 1;
      if (!invalid && this.entries.get(key) === entry) {
        this.touch(key, entry);
        if (verifyRate > 0 && this.random() < verifyRate) return this.verify(key, entry, loader, options);
        this.counts.hits++;
        this.report(key).hits++;
        this.tracker.noteRead(entry.tables);
        return answer(entry.value);
      }
      if (this.entries.get(key) === entry) this.remove(key, null);
    }

    const shared = this.loading.get(key);
    if (shared) {
      const result = await shared.catch(() => null);
      if (result && result.stored && !this.tracker.changedSince(result.tables, result.started)) {
        this.counts.shared++;
        this.report(key).shared++;
        this.tracker.noteRead(result.tables);
        // from the kept copy: the first caller may already be changing its own
        return answer(result.kept);
      }
    }

    this.counts.misses++;
    return this.load(key, loader, options);
  }

  /** Why a kept entry can't be served, or null when it can. */
  async whyInvalid(entry) {
    if (this.clock() >= entry.expiresAt) return 'expired';
    if (this.tracker.changedSince(entry.tables, entry.started)) return 'changed';
    if (this.stamps) {
      await this.tracker.capture.exit(() => this.stamps.fresh());
      if (!this.stamps.coveredSince(entry.tables, entry.stampSeq, entry.stampNow)) {
        return 'stamps not read before the load';
      }
      if (this.tracker.changedSince(entry.tables, entry.started)) return 'changed (stamps)';
    }
    return null;
  }

  /** The stamps can't be read: answer from the database, keep nothing. */
  withoutStamps(error, loader) {
    this.counts.stampFailures++;
    this.counts.bypassed++;
    this.warn(
      `[read-cache] can't read the table stamps, answering from the database: ${error && error.message}`,
    );
    return loader();
  }

  async load(key, loader, options) {
    const run = (async () => {
      // the declared tables' stamps are read before the load, so its result
      // is covered by the stamps from the start
      if (this.stamps && options.tables && options.tables.length) {
        const declared = options.tables.map((t) => String(t).toLowerCase());
        this.stamps.watch(declared);
        if (!this.stamps.coveredSince(declared, this.stamps.completed(), this.stamps.completedAt())) {
          try {
            await this.tracker.capture.exit(() => this.stamps.fresh());
          } catch {
            // not covered then: the result is loaded again on its next read
          }
        }
      }
      const started = this.tracker.now();
      const stampSeq = this.stamps ? this.stamps.completed() : 0;
      const stampNow = this.stamps ? this.stamps.completedAt() : null;
      const loadStarted = this.clock();
      let captured;
      try {
        captured = await this.tracker.captureReads(loader);
      } catch (error) {
        this.counts.notStored['load failed'] = (this.counts.notStored['load failed'] || 0) + 1;
        throw error;
      }
      const { result, store } = captured;
      this.noteLoad(key, this.clock() - loadStarted);
      const tables = [
        ...new Set([...(options.tables || []).map((t) => String(t).toLowerCase()), ...store.tables]),
      ];
      const reason = this.whyNotKept(result, store, tables, started, options);
      // what this load read is also read by whoever called it (an outer load
      // sees for itself a change during this one: it has the same tables and
      // began earlier); only an unsafe load makes the outer one unsafe too
      this.tracker.noteRead(tables, store.uncacheable);
      if (reason) {
        this.counts.notStored[reason] = (this.counts.notStored[reason] || 0) + 1;
        if (options.frozen) {
          try {
            deepFreeze(result);
          } catch {
            // left as it is: not kept anyway
          }
        }
        return { value: result, stored: false, tables, started };
      }
      let kept;
      let bytes;
      try {
        // frozen: the loader's own object, frozen and shared; otherwise a private copy
        bytes = measure(result, Boolean(options.frozen));
        kept = options.frozen ? result : copy(result);
      } catch {
        this.counts.notStored['not copyable'] = (this.counts.notStored['not copyable'] || 0) + 1;
        return { value: result, stored: false, tables, started };
      }
      const limit = Math.min(options.maxBytes || this.maxBytes / 4, this.maxBytes);
      if (bytes > limit) {
        this.counts.notStored['too big'] = (this.counts.notStored['too big'] || 0) + 1;
        return { value: result, stored: false, tables, started };
      }
      // the tables may have changed while the result was being copied: no,
      // copying is synchronous; but a disable() or clear() may have happened
      if (!this.isOn() || this.tracker.changedSince(tables, started)) {
        return { value: result, stored: false, tables, started };
      }
      this.store(key, {
        value: kept,
        tables,
        started,
        stampSeq,
        stampNow,
        bytes,
        expiresAt: this.clock() + (options.ttlMs || this.ttlMs),
      });
      if (this.stamps) this.stamps.watch(tables);
      return { value: result, kept, stored: true, tables, started };
    })();

    this.loading.set(key, run);
    try {
      const result = await run;
      // the cache keeps its own copy, so the loader's object is the caller's
      return result.value;
    } finally {
      if (this.loading.get(key) === run) this.loading.delete(key);
    }
  }

  whyNotKept(result, store, tables, started, options) {
    if (store.uncacheable) return store.uncacheable.split(':')[0];
    if (!tables.length) return 'no tables';
    if (options.keep && !options.keep(result)) return 'refused';
    if (this.tracker.changedSince(tables, started)) return 'changed while loading';
    for (const t of tables) {
      if (!this.tracker.known.has(t)) {
        this.warn(`[read-cache] "${t}" is not a table of this database: nothing depending on it is kept`);
        return 'unknown table';
      }
    }
    return null;
  }

  /** A sampled hit: load again and compare with what is kept. */
  async verify(key, entry, loader, options = {}) {
    this.counts.verified++;
    this.report(key).verified++;
    const started = this.tracker.now();
    const { result, store } = await this.tracker.captureReads(loader);
    const tables = [...new Set([...entry.tables, ...store.tables])];
    this.tracker.noteRead(tables, store.uncacheable);
    const changed = this.tracker.changedSince(tables, Math.min(started, entry.started));
    let same;
    try {
      same = canonicalJson(result) === canonicalJson(entry.value);
    } catch {
      same = false;
    }
    if (!same && !changed) {
      // dropped at once; whether it was a detection failure is decided after
      if (this.entries.get(key) === entry) this.remove(key, 'dropped');
      this.confirming = this.confirmMismatch(
        key,
        entry,
        firstDifference(entry.value, result),
        this.tracker.now(),
      );
    }
    if (options.frozen) {
      try {
        deepFreeze(result);
      } catch {
        // returned as it is
      }
    }
    return result;
  }

  /**
   * A verified hit differed from the database and no recorded change explains
   * it. A write from another process is noticed by the stamps up to ~4 s late
   * (by design), so the stamps are read again, and once more after the 2 s
   * recheck of recent stamps: a change they report for the entry's tables is
   * logged as a late notice (warning). Anything else is a detection failure
   * (error), the thing READ_CACHE_VERIFY is there to find.
   */
  async confirmMismatch(key, entry, difference, at) {
    try {
      if (this.stamps) {
        await this.tracker.capture.exit(() => this.stamps.check());
        await new Promise((resolve) => setTimeout(resolve, this.confirmWaitMs));
        await this.tracker.capture.exit(() => this.stamps.check());
      }
    } catch {
      // the stamps can't be read: nothing explains the difference
    }
    if (this.tracker.externallyChangedSince(entry.tables, at)) {
      this.counts.late++;
      this.warn(
        `[read-cache] "${key}" was served up to a few seconds after a write from outside this process, ` +
          `before the stamps noticed it (first difference: ${difference})`,
      );
      return 'late';
    }
    this.counts.mismatches++;
    if (this.log && this.log.error) {
      this.log.error(
        `[read-cache] STALE entry: "${key}" differed from the database although none of its tables changed ` +
          `(${entry.tables.join(', ')}); entry dropped. First difference: ${difference}`,
      );
    }
    return 'stale';
  }

  store(key, entry) {
    if (this.entries.has(key)) this.remove(key, null);
    entry.key = key;
    this.entries.set(key, entry);
    this.bytes += entry.bytes;
    for (const t of entry.tables) {
      if (!this.byTable.has(t)) this.byTable.set(t, new Set());
      this.byTable.get(t).add(key);
    }
    this.counts.stored++;
    while (this.bytes > this.maxBytes && this.entries.size > 1) {
      const oldest = this.entries.keys().next().value;
      this.remove(oldest, 'evicted');
    }
  }

  touch(key, entry) {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  remove(key, reason) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.bytes -= entry.bytes;
    for (const t of entry.tables) {
      const keys = this.byTable.get(t);
      if (keys) {
        keys.delete(key);
        if (!keys.size) this.byTable.delete(t);
      }
    }
    if (reason) this.counts[reason]++;
  }

  /** Frees the entries a change made stale (they would fail isValid anyway). */
  dropChanged(tables) {
    if (tables === null) {
      for (const key of [...this.entries.keys()]) this.remove(key, 'dropped');
      return;
    }
    for (const t of tables) {
      const keys = this.byTable.get(t);
      if (!keys) continue;
      for (const key of [...keys]) {
        const entry = this.entries.get(key);
        if (entry && this.tracker.changedSince(entry.tables, entry.started)) this.remove(key, 'dropped');
      }
    }
  }

  /** Drops everything; loads in progress won't be kept either. */
  clear(reason = 'clear') {
    this.tracker.everythingChanged(reason);
  }

  /** The figures of a key's report (created on first use). */
  report(key) {
    const family = familyOf(key);
    let figures = this.reports.get(family);
    if (!figures) {
      figures = {
        hits: 0,
        shared: 0,
        verified: 0,
        firstLoads: 0,
        loadsAgain: 0,
        loadMsTotal: 0,
        loadMsMax: 0,
        lastLoadMs: null,
        lastLoadAt: null,
      };
      this.reports.set(family, figures);
    }
    return figures;
  }

  /**
   * A load someone waited for: the first of its key since the start (a
   * deploy, a restart), or a load again after a change, the TTL or the cap.
   * A slow one is also logged, to follow it across tenants in the logs.
   */
  noteLoad(key, ms) {
    const figures = this.report(key);
    const again = this.loadedKeys.has(key);
    if (!again) {
      if (this.loadedKeys.size >= MAX_LOADED_KEYS) this.loadedKeys.clear();
      this.loadedKeys.add(key);
    }
    if (again) figures.loadsAgain++;
    else figures.firstLoads++;
    figures.loadMsTotal += ms;
    figures.loadMsMax = Math.max(figures.loadMsMax, ms);
    figures.lastLoadMs = ms;
    figures.lastLoadAt = this.clock();
    if (ms >= this.slowLoadMs && this.log && this.log.info) {
      this.log.info(
        `[read-cache] slow load: ${familyOf(key)} ${Math.round(ms)} ms (${again ? 'again' : 'first since start'})`,
      );
    }
  }

  stats() {
    return {
      on: this.isOn(),
      failure: this.tracker.failure ? this.tracker.failure.message : null,
      entries: this.entries.size,
      bytes: this.bytes,
      maxBytes: this.maxBytes,
      ttlMs: this.ttlMs,
      verifyRate: this.verifyRate,
      ...this.counts,
      tracker: { ...this.tracker.stats, tables: this.tracker.tables.length },
      since: new Date(this.startedAt).toISOString(),
      reports: Object.fromEntries(
        [...this.reports].map(([family, f]) => [
          family,
          {
            ...f,
            loadMsTotal: Math.round(f.loadMsTotal),
            loadMsMax: Math.round(f.loadMsMax),
            lastLoadMs: f.lastLoadMs === null ? null : Math.round(f.lastLoadMs),
            lastLoadAt: f.lastLoadAt === null ? null : new Date(f.lastLoadAt).toISOString(),
          },
        ]),
      ),
      stamps: this.stamps ? { ...this.stamps.stats, watched: this.stamps.watched.size } : null,
    };
  }

  warn(message) {
    const now = this.clock();
    this.lastWarn = this.lastWarn || new Map();
    if (this.lastWarn.has(message) && now - this.lastWarn.get(message) < 60 * 1000) return;
    this.lastWarn.set(message, now);
    if (this.log && this.log.warn) this.log.warn(message);
  }
}

module.exports = { ReadCache, MB, deepFreeze, measure, firstDifference, canonicalJson, familyOf };
