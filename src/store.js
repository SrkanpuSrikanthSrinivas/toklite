import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './config.js';

const STATS = path.join(HOME, 'stats.json');
const LOG = path.join(HOME, 'requests.jsonl');

const EMPTY = {
  requests: 0, cacheHits: 0, shadowRequests: 0,
  measured: 0, unmeasured: 0,        // exactly measured vs not measurable
  tokensBefore: 0, tokensAfter: 0,   // exact, provider-reported, measured requests only
  outputTokens: 0,
  cacheReadTokens: 0, cacheWriteTokens: 0,
  costActual: 0, costBaseline: 0,    // USD, measured requests only
  charsRemoved: {},                  // exact bytes removed, per reducer
  unmeasuredReasons: {},
  since: new Date().toISOString()
};

export function read() {
  try { return { ...EMPTY, ...JSON.parse(fs.readFileSync(STATS, 'utf8')) }; }
  catch { return structuredClone(EMPTY); }
}

function write(s) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(STATS, JSON.stringify(s, null, 2));
}

/** Called once per request, immediately. Contains no token numbers. */
export function recordRequest({ cacheHit, shadow, report, model }) {
  const s = read();
  s.requests++;
  if (cacheHit) s.cacheHits++;
  if (shadow) s.shadowRequests++;
  for (const r of report || []) {
    if (r.chars > 0) s.charsRemoved[r.name] = (s.charsRemoved[r.name] || 0) + r.chars;
  }
  write(s);
  fs.appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), kind: 'request', model, cacheHit, shadow }) + '\n');
}

/**
 * Called later, once the exact numbers are known. Requests that could not be
 * measured are counted separately and never filled in with an estimate.
 */
export function recordMeasurement({ model, before, after, method, reason, usage, costActual, costBaseline }) {
  const s = read();
  if (typeof before === 'number' && typeof after === 'number') {
    s.measured++;
    s.tokensBefore += before;
    s.tokensAfter += after;
    s.outputTokens += usage?.output_tokens || 0;
    s.cacheReadTokens += usage?.cache_read_input_tokens || 0;
    s.cacheWriteTokens += usage?.cache_creation_input_tokens || 0;
    if (typeof costActual === 'number') s.costActual += costActual;
    if (typeof costBaseline === 'number') s.costBaseline += costBaseline;
  } else {
    s.unmeasured++;
    const key = reason || method || 'unknown';
    s.unmeasuredReasons[key] = (s.unmeasuredReasons[key] || 0) + 1;
  }
  write(s);
  fs.appendFileSync(LOG, JSON.stringify({
    t: new Date().toISOString(), kind: 'measurement', model, before, after, method, reason, costActual, costBaseline
  }) + '\n');
}

export function reset() {
  try { fs.unlinkSync(STATS); } catch {}
  try { fs.unlinkSync(LOG); } catch {}
}
