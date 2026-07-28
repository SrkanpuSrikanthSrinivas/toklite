/**
 * Where do the tokens actually go?
 *
 * Bucket sizes are measured by ABLATION, not attribution: count the request
 * once, then count it again with one bucket blanked out, and the difference is
 * that bucket's exact token cost. count_tokens is free, so this is exact and
 * costs nothing but rate limit.
 *
 * Byte-share attribution would be a guess — code, prose, base64 and JSON all
 * tokenize at very different densities, so a bucket holding 40% of the bytes
 * can easily hold 20% or 60% of the tokens.
 */
import { walkTexts } from './adapters.js';
import { reduceSync } from './reducers.js';
import * as counter from './counter.js';

const BLANK = '.';   // count_tokens rejects empty text blocks

export const BUCKETS = ['system', 'tools', 'tool_results', 'user_text', 'assistant_text', 'images'];

function bucketOf(handle) {
  // Anthropic's system prompt arrives as an array of text blocks, so the
  // block kind reads as 'text'. Role is the reliable discriminator.
  if (handle.role === 'system' || handle.kind === 'system') return 'system';
  if (handle.kind === 'tool_result') return 'tool_results';
  return handle.role === 'assistant' ? 'assistant_text' : 'user_text';
}

/** Exact local byte sizes per bucket. */
export function bytesByBucket(body, format) {
  const out = Object.fromEntries(BUCKETS.map(b => [b, 0]));
  for (const h of walkTexts(body, format)) {
    const t = h.get();
    if (typeof t === 'string') out[bucketOf(h)] += Buffer.byteLength(t);
  }
  if (body.tools) out.tools = Buffer.byteLength(JSON.stringify(body.tools));
  out.images = imageBytes(body);
  return out;
}

function imageBytes(body) {
  let n = 0;
  for (const msg of body.messages || []) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block?.type === 'image' && block.source?.data) n += block.source.data.length;
      if (block?.type === 'image_url' && block.image_url?.url) n += block.image_url.url.length;
    }
  }
  return n;
}

/** Return a copy of the body with one bucket blanked out. */
function ablate(body, format, bucket) {
  const clone = structuredClone(body);
  if (bucket === 'tools') {
    delete clone.tools;
    delete clone.tool_choice;
    return clone;
  }
  if (bucket === 'images') {
    for (const msg of clone.messages || []) {
      if (!Array.isArray(msg.content)) continue;
      msg.content = msg.content.filter(b => b?.type !== 'image' && b?.type !== 'image_url');
      if (!msg.content.length) msg.content = [{ type: 'text', text: BLANK }];
    }
    return clone;
  }
  for (const h of walkTexts(clone, format)) {
    if (bucketOf(h) === bucket) h.set(BLANK);
  }
  return clone;
}

/** How many bytes does toklite already remove from each bucket? */
export function reducedByBucket(body, format, cfg) {
  const before = bytesByBucket(body, format);
  const { body: after } = reduceSync(structuredClone(body), format, cfg);
  const post = bytesByBucket(after, format);
  const out = {};
  for (const b of BUCKETS) out[b] = Math.max(0, before[b] - post[b]);
  return out;
}

/**
 * Profile one request. One count for the total plus one per non-empty bucket.
 * All free.
 */
export async function profileRequest(body, format, headers, upstream, cfg) {
  const total = await counter.countExact(body, format, headers, upstream, cfg);
  if (!total?.tokens) return { ok: false, reason: total?.reason || 'count failed' };

  const bytes = bytesByBucket(body, format);
  const tokens = {};
  for (const bucket of BUCKETS) {
    if (!bytes[bucket]) { tokens[bucket] = 0; continue; }
    const ablated = await counter.countExact(ablate(body, format, bucket), format, headers, upstream, cfg);
    tokens[bucket] = ablated?.tokens != null ? Math.max(0, total.tokens - ablated.tokens) : null;
  }

  return {
    ok: true,
    model: body.model,
    total: total.tokens,
    bytes,
    tokens,
    reducedBytes: reducedByBucket(body, format, cfg),
    cached: cacheTier(body)
  };
}

/**
 * Tokens sitting behind a cache breakpoint bill at roughly a tenth of the
 * normal input rate, so a bucket's share of the token count and its share of
 * the bill are different numbers. Reduction aimed at cached content is worth
 * about a tenth of reduction aimed at fresh content.
 */
function cacheTier(body) {
  const marks = [];
  const scan = (v, path) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach((x, i) => scan(x, path));
    if (v.cache_control) marks.push(path);
    Object.values(v).forEach(x => scan(x, path));
  };
  scan(body.tools, 'tools');
  scan(body.system, 'system');
  scan(body.messages, 'messages');
  return { breakpoints: marks.length, regions: [...new Set(marks)] };
}

export function aggregate(results) {
  const ok = results.filter(r => r.ok);
  if (!ok.length) return null;
  const sum = (f) => ok.reduce((a, r) => a + (f(r) || 0), 0);
  const out = { n: ok.length, total: sum(r => r.total), buckets: {} };
  for (const b of BUCKETS) {
    out.buckets[b] = {
      tokens: sum(r => r.tokens[b]),
      bytes: sum(r => r.bytes[b]),
      reducedBytes: sum(r => r.reducedBytes[b])
    };
  }
  out.breakpoints = sum(r => r.cached.breakpoints);
  return out;
}
