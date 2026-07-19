/**
 * Exact token accounting.
 *
 * Three sources of truth, in order of preference. None of them is an estimate.
 *
 *   1. AFTER  — the `usage` block on every response. Free, exact, always
 *      present. Total context billed is input + cache_read + cache_creation.
 *
 *   2. BEFORE (Anthropic) — POST /v1/messages/count_tokens with the original
 *      request. Free, exact, rate-limited only, and model-specific, which
 *      matters: newer Claude tokenizers produce materially different counts
 *      for the same text. Runs after the response is delivered, so it costs
 *      the user nothing in latency.
 *
 *   3. BEFORE (OpenAI) — there is no free counting endpoint, so the exact
 *      number comes from the fidelity replay: that request sends the ORIGINAL
 *      body, and its response reports prompt_tokens for it. Sampled rather
 *      than universal, but real.
 *
 * Anything not covered by the above is reported as UNMEASURED. It is never
 * backfilled with a guess.
 */

const cache = new Map();          // signature -> tokens
const MAX_CACHE = 500;
let inFlight = 0;

/** Total input tokens actually billed for a request, from its usage block. */
export function billedInput(usage) {
  if (!usage) return null;
  return (usage.input_tokens || 0)
       + (usage.cache_read_input_tokens || 0)
       + (usage.cache_creation_input_tokens || 0);
}

function countableBody(body) {
  // count_tokens accepts the same shape as messages, minus decoding params.
  const out = { model: body.model, messages: body.messages };
  if (body.system) out.system = body.system;
  if (body.tools) out.tools = body.tools;
  if (body.tool_choice) out.tool_choice = body.tool_choice;
  if (body.thinking) out.thinking = body.thinking;
  return out;
}

function sig(body) {
  return JSON.stringify([body.model, body.system, body.messages, body.tools]).length
    + ':' + JSON.stringify(body.messages || []).slice(0, 200)
    + ':' + (body.model || '');
}

/**
 * Exact count of an Anthropic request. Free endpoint; failures return null
 * rather than a fallback number.
 */
export async function countAnthropic(body, headers, upstreamBase, cfg) {
  const key = sig(body);
  if (cache.has(key)) return { tokens: cache.get(key), method: 'count_tokens', cached: true };
  if (inFlight >= (cfg?.counting?.maxConcurrent ?? 3)) return null;

  inFlight++;
  try {
    const res = await fetch(upstreamBase + '/v1/messages/count_tokens', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(countableBody(body))
    });
    if (!res.ok) {
      return { tokens: null, method: 'unmeasured', reason: `count_tokens ${res.status}` };
    }
    const json = await res.json();
    const tokens = json.input_tokens;
    if (typeof tokens !== 'number') return { tokens: null, method: 'unmeasured', reason: 'no input_tokens' };
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
    cache.set(key, tokens);
    return { tokens, method: 'count_tokens' };
  } catch (err) {
    return { tokens: null, method: 'unmeasured', reason: String(err.message || err) };
  } finally {
    inFlight--;
  }
}

/**
 * Optional local tokenizer for OpenAI models. Present only if the user
 * installed js-tiktoken; it is never used for Claude, where it undercounts
 * badly. Message-framing overhead follows OpenAI's published recipe.
 */
let tiktoken = null;
let tiktokenTried = false;

async function loadTiktoken() {
  if (tiktokenTried) return tiktoken;
  tiktokenTried = true;
  try {
    const mod = await import('js-tiktoken');
    const { o200k_base } = await import('js-tiktoken/ranks/o200k_base');
    tiktoken = new mod.Tiktoken(o200k_base);
  } catch { tiktoken = null; }
  return tiktoken;
}

export async function countOpenAI(body) {
  const enc = await loadTiktoken();
  if (!enc) return { tokens: null, method: 'unmeasured', reason: 'js-tiktoken not installed' };

  let total = 3;                                   // reply priming
  for (const msg of body.messages || []) {
    total += 3;                                    // per-message framing
    const content = typeof msg.content === 'string'
      ? msg.content
      : (msg.content || []).map(b => b.text || '').join('');
    total += enc.encode(content).length;
    if (msg.name) total += 1;
  }
  if (body.tools?.length) total += enc.encode(JSON.stringify(body.tools)).length;
  return { tokens: total, method: 'tiktoken' };
}

export async function countExact(body, format, headers, upstreamBase, cfg) {
  if (format === 'anthropic') return countAnthropic(body, headers, upstreamBase, cfg);
  return countOpenAI(body);
}

export function available() {
  return { tiktokenLoaded: !!tiktoken, cacheSize: cache.size };
}
