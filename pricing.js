// Rates in USD per million tokens. Sourced from public pricing pages,
// July 2026. Prices change: `toklite pricing` prints this table with its
// date, and any entry can be overridden in config under `pricing`.
export const PRICING_DATE = '2026-07-18';

export const TABLE = {
  // Anthropic
  'claude-haiku-4-5':  { in: 1,  out: 5 },
  'claude-sonnet-4-6': { in: 3,  out: 15 },
  'claude-sonnet-5':   { in: 3,  out: 15 },
  'claude-opus-4-6':   { in: 5,  out: 25 },
  'claude-opus-4-7':   { in: 5,  out: 25 },
  'claude-opus-4-8':   { in: 5,  out: 25 },
  'claude-fable-5':    { in: 10, out: 50 },
  'claude-mythos-5':   { in: 10, out: 50 },
  // OpenAI
  'gpt-4o-mini':       { in: 0.15, out: 0.6 },
  'gpt-4o':            { in: 2.5,  out: 10 },
  'o3-mini':           { in: 1.1,  out: 4.4 }
};

// Cache multipliers relative to the input rate. Reads are the 90% discount;
// writes carry a surcharge, which is why cachePoints has to be measured
// rather than assumed to be free.
export const CACHE_READ_MULT = 0.1;
export const CACHE_WRITE_MULT = 1.25;   // 5-minute TTL; 1-hour is 2.0

export function rates(model, cfg) {
  const overrides = cfg?.pricing || {};
  const m = String(model || '').toLowerCase();
  const table = { ...TABLE, ...overrides };
  if (table[m]) return { ...table[m], matched: m };
  // Longest prefix wins, so dated ids like claude-sonnet-5-20260630 resolve.
  let best = null;
  for (const key of Object.keys(table)) {
    if (m.startsWith(key) && (!best || key.length > best.length)) best = key;
  }
  return best ? { ...table[best], matched: best } : null;
}

/** What the provider actually charged, from the usage block it returned. */
export function actualCost(model, usage, cfg) {
  const r = rates(model, cfg);
  if (!r || !usage) return null;
  const M = 1e6;
  return (
    (usage.input_tokens || 0) * r.in / M +
    (usage.cache_read_input_tokens || 0) * r.in * CACHE_READ_MULT / M +
    (usage.cache_creation_input_tokens || 0) * r.in * CACHE_WRITE_MULT / M +
    (usage.output_tokens || 0) * r.out / M
  );
}

/**
 * What the same call would have cost unreduced: the exact token count of the
 * original request, billed at full uncached input rate, plus the identical
 * output. Output is held constant because reduction targets input.
 */
export function baselineCost(model, beforeTokens, outputTokens, cfg) {
  const r = rates(model, cfg);
  if (!r) return null;
  const M = 1e6;
  return (beforeTokens * r.in / M) + ((outputTokens || 0) * r.out / M);
}

export function usd(n) {
  if (n === null || n === undefined) return '—';
  if (Math.abs(n) >= 1) return '$' + n.toFixed(2);
  if (Math.abs(n) >= 0.01) return '$' + n.toFixed(4);
  return '$' + n.toFixed(6);
}
