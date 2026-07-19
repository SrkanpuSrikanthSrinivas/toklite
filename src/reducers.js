import crypto from 'node:crypto';
import { walkTexts, turnCount } from './adapters.js';

// Reducers report characters removed, which is an exact measurement taken
// locally. Token counts are never estimated here: the real before/after
// numbers come from the provider (see counter.js), and each reducer's share
// of the measured saving is apportioned by the bytes it actually removed.

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);

/* ------------------------------------------------------------------ *
 * 1. HYGIENE — strip tokens that carry no information.
 *    Safe on every payload. Small but free.
 * ------------------------------------------------------------------ */
function hygiene(body, format) {
  let saved = 0;
  for (const h of walkTexts(body, format)) {
    const before = h.get();
    if (typeof before !== 'string') continue;
    const after = before
      .replace(/[ \t]+$/gm, '')          // trailing whitespace
      .replace(/\n{4,}/g, '\n\n\n')      // runaway blank lines
      .replace(/^(\s*[-=_*#]{20,})$/gm, '---'); // ASCII separator bars
    if (after.length < before.length) {
      saved += before.length - after.length;
      h.set(after);
    }
  }
  return { name: 'hygiene', chars: saved };
}

/* ------------------------------------------------------------------ *
 * 2. DEDUPE — agents re-send the same file, schema, or log over and over.
 *
 * Detection is anchor-based, not chunk-based. Every WINDOW-length window at
 * a STEP-sized stride is fingerprinted; any fingerprint seen twice is a
 * candidate, and the match is then extended character by character in both
 * directions to find the maximal shared region.
 *
 * The obvious cheaper design -- cut both texts into chunks and compare the
 * chunks -- fails on exactly the content agents produce most. Repetitive
 * files put the two copies in different phase, so the cut points land in
 * different places and no chunk ever matches. Anchors have no phase.
 *
 * The LAST occurrence of any region is always preserved: it is the
 * authoritative one. Earlier copies are replaced by a pointer to it.
 * ------------------------------------------------------------------ */
const WINDOW = 64;
const STEP = 16;

function fnv(str, from, len) {
  let h = 0x811c9dc5;
  for (let i = from; i < from + len; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** Grow a known-equal window into the largest region shared by both texts. */
function extend(aText, aPos, bText, bPos) {
  let start = 0;
  while (aPos - start > 0 && bPos - start > 0 &&
  aText[aPos - start - 1] === bText[bPos - start - 1]) start++;
  let end = WINDOW;
  while (aPos + end < aText.length && bPos + end < bText.length &&
  aText[aPos + end] === bText[bPos + end]) end++;
  return { aStart: aPos - start, aEnd: aPos + end, length: start + end };
}

function mergeIntervals(list) {
  if (!list.length) return [];
  list.sort((x, y) => x.start - y.start);
  const out = [list[0]];
  for (const iv of list.slice(1)) {
    const last = out[out.length - 1];
    if (iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else out.push(iv);
  }
  return out;
}

function dedupe(body, format, opt) {
  const handles = walkTexts(body, format);
  const texts = handles.map(h => (typeof h.get() === 'string' ? h.get() : null));

  // Index every anchor position across the whole conversation.
  const index = new Map();                       // fingerprint -> [{hi, pos}]
  texts.forEach((t, hi) => {
    if (!t || t.length < WINDOW) return;
    for (let pos = 0; pos + WINDOW <= t.length; pos += STEP) {
      const key = fnv(t, pos, WINDOW);
      let bucket = index.get(key);
      if (!bucket) index.set(key, (bucket = []));
      bucket.push({ hi, pos });
    }
  });

  const elisions = texts.map(() => []);
  let saved = 0;

  for (const bucket of index.values()) {
    if (bucket.length < 2) continue;
    const keeper = bucket[bucket.length - 1];    // last occurrence wins

    for (const cand of bucket.slice(0, -1)) {
      if (cand.hi === keeper.hi && Math.abs(cand.pos - keeper.pos) < WINDOW) continue;
      // Skip anchors already inside a region we have decided to elide.
      if (elisions[cand.hi].some(iv => cand.pos >= iv.start && cand.pos < iv.end)) continue;

      const a = texts[cand.hi], b = texts[keeper.hi];
      if (a.substr(cand.pos, WINDOW) !== b.substr(keeper.pos, WINDOW)) continue;  // fingerprint collision

      const m = extend(a, cand.pos, b, keeper.pos);
      if (m.length < opt.minChars) continue;
      if (cand.hi === keeper.hi && m.aStart <= keeper.pos && m.aEnd > keeper.pos) continue; // self-overlap
      elisions[cand.hi].push({ start: m.aStart, end: m.aEnd, keeperTurn: handles[keeper.hi].turn });
    }
  }

  texts.forEach((t, hi) => {
    const merged = mergeIntervals(elisions[hi]);
    if (!merged.length) return;
    let out = '', cursor = 0;
    for (const iv of merged) {
      const removed = t.slice(iv.start, iv.end);
      const stub = `[toklite: ${removed.length} characters elided — this content is repeated verbatim later in the conversation, in message #${iv.keeperTurn}, where the current copy appears.]`;
      const delta = removed.length - stub.length;
      if (delta <= 0) continue;                  // never make a payload larger
      saved += delta;
      out += t.slice(cursor, iv.start) + stub;
      cursor = iv.end;
    }
    if (!cursor) return;
    handles[hi].set(out + t.slice(cursor));
  });

  return { name: 'dedupe', chars: saved };
}

/* ------------------------------------------------------------------ *
 * 3. COMPACT — older turns rarely need full fidelity. Truncate long
 *    blocks outside the recency window to head + tail with an explicit
 *    elision marker so the model knows something was removed.
 * ------------------------------------------------------------------ */
function compact(body, format, opt) {
  const total = turnCount(body);
  const cutoff = total - opt.keepRecentTurns;
  if (cutoff <= 0) return { name: 'compact', chars: 0 };

  let saved = 0;
  for (const h of walkTexts(body, format)) {
    if (h.turn < 0 || h.turn >= cutoff) continue;   // keep system + recent turns intact
    const text = h.get();
    if (typeof text !== 'string' || text.length <= opt.maxOldBlockChars) continue;

    const head = text.slice(0, opt.headChars);
    const tail = text.slice(-opt.tailChars);
    const cut = text.length - head.length - tail.length;
    const after = `${head}\n\n[toklite: ${cut} characters elided from an older turn. Re-read the source if the omitted region matters.]\n\n${tail}`;
    const delta = text.length - after.length;
    if (delta <= 0) continue;
    saved += delta;
    h.set(after);
  }
  return { name: 'compact', chars: saved };
}

/* ------------------------------------------------------------------ *
 * 4. TOOLS — agent frameworks resend every tool schema on every turn.
 *    Names and parameter shapes are load-bearing and never touched.
 *    Prose descriptions on tools the conversation has never mentioned
 *    are collapsed to their first sentence.
 * ------------------------------------------------------------------ */
function tools(body, format, opt) {
  const list = body.tools;
  if (!Array.isArray(list) || list.length === 0) return { name: 'tools', chars: 0 };

  const toolChars = JSON.stringify(list).length;
  if (toolChars < opt.minToolChars) return { name: 'tools', chars: 0 };

  const convo = walkTexts(body, format).map(h => h.get()).join('\n').toLowerCase();
  let saved = 0;

  for (const tool of list) {
    const spec = tool.function || tool;
    const name = (spec.name || '').toLowerCase();
    if (!name || convo.includes(name)) continue;   // referenced -> leave alone

    if (typeof spec.description === 'string' && spec.description.length > 160) {
      const before = spec.description;
      const firstSentence = before.split(/(?<=[.!?])\s/)[0];
      const after = firstSentence.length < before.length ? firstSentence : before.slice(0, 160);
      const delta = before.length - after.length;
      if (delta > 0) { saved += delta; spec.description = after; }
    }

    const params = spec.parameters || spec.input_schema;
    if (params?.properties) {
      for (const prop of Object.values(params.properties)) {
        if (prop && typeof prop.description === 'string' && prop.description.length > 120) {
          const before = prop.description;
          const after = before.slice(0, 120).replace(/\s+\S*$/, '');
          saved += before.length - after.length;
          prop.description = after;
        }
      }
    }
  }
  return { name: 'tools', chars: saved };
}

/* ------------------------------------------------------------------ *
 * 5. CACHE POINTS — Anthropic only. Marks the stable prefix (tools +
 *    system) so the provider bills it at cache rates. This does not
 *    shrink the payload; it changes what the payload COSTS, which is
 *    usually the single largest win in an agent loop.
 * ------------------------------------------------------------------ */
/** Does the request already carry any cache_control breakpoints? */
function hasCacheControl(body) {
  const seen = (v) => {
    if (!v || typeof v !== 'object') return false;
    if (Array.isArray(v)) return v.some(seen);
    if (v.cache_control) return true;
    return Object.values(v).some(x => x && typeof x === 'object' && seen(x));
  };
  return seen(body.tools) || seen(body.system) || seen(body.messages);
}

function cachePoints(body, format) {
  if (format !== 'anthropic') return { name: 'cachePoints', chars: 0, note: 'n/a' };

  // If the caller already manages prompt caching, leave it completely alone.
  //
  // Adding our own breakpoint on top is not merely redundant, it is invalid:
  // Anthropic processes blocks in the order tools -> system -> messages, and a
  // ttl='1h' block must never follow a ttl='5m' one. A default 5m breakpoint
  // injected into `tools` therefore breaks any client that puts a 1h block in
  // `system`, with "400 cache_control.ttl". There is also a hard limit of four
  // breakpoints per request, which we could otherwise push a client past.
  //
  // Clients that do this well (Claude Code among them) already place better
  // breakpoints than we can infer from a single request in isolation.
  if (hasCacheControl(body)) {
    return { name: 'cachePoints', chars: 0, note: 'client-managed, left untouched' };
  }

  let marked = 0;
  if (Array.isArray(body.tools) && body.tools.length) {
    const last = body.tools[body.tools.length - 1];
    if (last && typeof last === 'object') { last.cache_control = { type: 'ephemeral' }; marked++; }
  }
  if (typeof body.system === 'string' && body.system.length > 500) {
    body.system = [{ type: 'text', text: body.system, cache_control: { type: 'ephemeral' } }];
    marked++;
  } else if (Array.isArray(body.system) && body.system.length) {
    const last = body.system[body.system.length - 1];
    if (last && typeof last === 'object') { last.cache_control = { type: 'ephemeral' }; marked++; }
  }
  return { name: 'cachePoints', chars: 0, marked };
}

/* ------------------------------------------------------------------ *
 * 6. TERSE — output tokens cost 3-5x input. Opt-in, off by default,
 *    because it changes response style.
 * ------------------------------------------------------------------ */
function terse(body, format, opt) {
  const line = opt.text;
  if (format === 'anthropic') {
    if (typeof body.system === 'string') body.system += '\n\n' + line;
    else if (Array.isArray(body.system)) body.system.push({ type: 'text', text: line });
    else body.system = line;
  } else {
    body.messages = body.messages || [];
    body.messages.unshift({ role: 'system', content: line });
  }
  return { name: 'terse', chars: 0 };
}

/* ------------------------------------------------------------------ */

export function reduce(originalBody, format, cfg) {
  const body = structuredClone(originalBody);
  const r = cfg.reducers;
  const report = [];

  if (r.hygiene.enabled)     report.push(hygiene(body, format));
  if (r.dedupe.enabled)      report.push(dedupe(body, format, r.dedupe));
  if (r.compact.enabled)     report.push(compact(body, format, r.compact));
  if (r.tools.enabled)       report.push(tools(body, format, r.tools));
  if (r.cachePoints.enabled) report.push(cachePoints(body, format));
  if (r.terse.enabled)       report.push(terse(body, format, r.terse));

  return { body, report };
}