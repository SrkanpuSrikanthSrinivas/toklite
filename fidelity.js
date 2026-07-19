import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './config.js';

const LOG = path.join(HOME, 'fidelity.jsonl');
const BUDGET = path.join(HOME, 'fidelity-budget.json');

let inFlight = 0;

/* ------------------------------------------------------------------ *
 * Budget — the audit costs real tokens. It is capped per day and the
 * overhead is reported, never hidden.
 * ------------------------------------------------------------------ */
function today() { return new Date().toISOString().slice(0, 10); }

function readBudget() {
  try {
    const b = JSON.parse(fs.readFileSync(BUDGET, 'utf8'));
    return b.day === today() ? b : { day: today(), spent: 0 };
  } catch { return { day: today(), spent: 0 }; }
}

function addSpend(tokens) {
  const b = readBudget();
  b.spent += tokens;
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(BUDGET, JSON.stringify(b));
}

export function shouldSample(cfg, { cacheHit }) {
  const f = cfg.fidelity;
  if (!f?.enabled || cfg.shadow) return false;
  if (cacheHit) return false;                       // nothing was reduced upstream to compare
  if (inFlight >= f.maxConcurrent) return false;
  if (readBudget().spent >= f.dailyBudgetTokens) return false;
  return Math.random() < f.sampleRate;
}

/* ------------------------------------------------------------------ *
 * Output extraction — what the model actually produced, in a shape we
 * can compare. Tool calls matter more than prose: in an agent loop a
 * different tool call is a behavioural change, a reworded sentence is not.
 * ------------------------------------------------------------------ */
export function extractOutput(json, format) {
  const out = { text: '', toolCalls: [] };
  if (!json) return out;

  if (format === 'anthropic') {
    for (const block of json.content || []) {
      if (block.type === 'text') out.text += block.text || '';
      if (block.type === 'tool_use') out.toolCalls.push({ name: block.name, args: block.input ?? {} });
    }
  } else {
    const msg = json.choices?.[0]?.message || {};
    out.text += msg.content || '';
    for (const tc of msg.tool_calls || []) {
      let args = {};
      try { args = JSON.parse(tc.function?.arguments || '{}'); } catch {}
      out.toolCalls.push({ name: tc.function?.name, args });
    }
  }
  return out;
}

export function extractStreamOutput(sse, format) {
  const out = { text: '', toolCalls: [] };
  const partial = new Map(); // index -> { name, json }

  for (const line of sse.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let j; try { j = JSON.parse(payload); } catch { continue; }

    if (format === 'anthropic') {
      if (j.type === 'content_block_start' && j.content_block?.type === 'tool_use') {
        partial.set(j.index, { name: j.content_block.name, json: '' });
      }
      if (j.type === 'content_block_delta') {
        if (j.delta?.type === 'text_delta') out.text += j.delta.text || '';
        if (j.delta?.type === 'input_json_delta' && partial.has(j.index)) {
          partial.get(j.index).json += j.delta.partial_json || '';
        }
      }
    } else {
      const d = j.choices?.[0]?.delta || {};
      if (d.content) out.text += d.content;
      for (const tc of d.tool_calls || []) {
        const i = tc.index ?? 0;
        if (!partial.has(i)) partial.set(i, { name: '', json: '' });
        const p = partial.get(i);
        if (tc.function?.name) p.name = tc.function.name;
        if (tc.function?.arguments) p.json += tc.function.arguments;
      }
    }
  }

  for (const p of partial.values()) {
    let args = {};
    try { args = JSON.parse(p.json || '{}'); } catch {}
    out.toolCalls.push({ name: p.name, args });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Scoring
 * ------------------------------------------------------------------ */
function bigrams(text) {
  const words = String(text).toLowerCase().match(/[a-z0-9']+/g) || [];
  const set = new Set();
  for (let i = 0; i < words.length - 1; i++) set.add(words[i] + ' ' + words[i + 1]);
  if (words.length === 1) set.add(words[0]);
  return set;
}

/** Dice coefficient over word bigrams: 1.0 identical, 0.0 nothing in common. */
export function textSimilarity(a, b) {
  if (a === b) return 1;
  const A = bigrams(a), B = bigrams(b);
  if (!A.size && !B.size) return 1;
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const g of A) if (B.has(g)) shared++;
  return (2 * shared) / (A.size + B.size);
}

function sameArgs(a, b) {
  return JSON.stringify(a, Object.keys(a || {}).sort()) === JSON.stringify(b, Object.keys(b || {}).sort());
}

export function score(reduced, original, cfg) {
  const t = cfg.fidelity.matchThreshold;
  const textSim = textSimilarity(reduced.text, original.text);

  const rNames = reduced.toolCalls.map(c => c.name).join('|');
  const oNames = original.toolCalls.map(c => c.name).join('|');

  if (rNames !== oNames) {
    return { verdict: 'divergent', reason: 'different tool calls', textSim, toolSim: 0 };
  }
  if (reduced.toolCalls.length) {
    const argMatches = reduced.toolCalls.filter((c, i) => sameArgs(c.args, original.toolCalls[i].args)).length;
    const toolSim = argMatches / reduced.toolCalls.length;
    if (toolSim < 1) return { verdict: 'divergent', reason: 'same tools, different arguments', textSim, toolSim };
    return { verdict: 'match', reason: 'identical tool calls', textSim, toolSim: 1 };
  }

  if (textSim >= t) return { verdict: 'match', reason: 'text within threshold', textSim, toolSim: null };
  if (textSim >= t - 0.25) return { verdict: 'near', reason: 'text drifted but overlaps', textSim, toolSim: null };
  return { verdict: 'divergent', reason: 'text substantially different', textSim, toolSim: null };
}

/* ------------------------------------------------------------------ *
 * The check itself. Runs AFTER the client has its answer, so it never
 * adds latency to the request being served.
 * ------------------------------------------------------------------ */
export async function runCheck({ url, headers, originalBody, format, reducedOutput, bytesRemoved, cfg, onDone }) {
  inFlight++;
  try {
    const probe = { ...originalBody, stream: false };
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(probe)
    });
    if (!res.ok) return;
    const json = await res.json();

    // The replay bills the ORIGINAL request, so its usage block is the exact
    // token count of the unreduced payload — the audit doubles as ground
    // truth for providers with no free counting endpoint.
    const u = json.usage || {};
    const overhead = (u.input_tokens ?? u.prompt_tokens ?? 0)
                   + (u.cache_read_input_tokens || 0)
                   + (u.cache_creation_input_tokens || 0);
    addSpend(overhead);

    const original = extractOutput(json, format);
    const result = score(reducedOutput, original, cfg);

    const record = {
      t: new Date().toISOString(),
      model: originalBody.model,
      bytesRemoved,
      unreducedTokens: overhead,          // exact, billed by the provider
      overheadTokens: overhead,
      ...result,
      reducedText: reducedOutput.text.slice(0, 400),
      originalText: original.text.slice(0, 400)
    };
    fs.mkdirSync(HOME, { recursive: true });
    fs.appendFileSync(LOG, JSON.stringify(record) + '\n');
    onDone?.(record);
  } catch (err) { if (process.env.TOKLITE_DEBUG) console.error('[fidelity]', err); /* an audit failure must never affect the served request */ }
  finally { inFlight--; }
}

export function readSamples(limit = Infinity) {
  try {
    return fs.readFileSync(LOG, 'utf8').trim().split('\n')
      .filter(Boolean).map(l => JSON.parse(l)).slice(-limit);
  } catch { return []; }
}

export function summarize(samples) {
  if (!samples.length) return null;
  const by = v => samples.filter(s => s.verdict === v).length;
  const avg = k => samples.reduce((a, s) => a + (s[k] || 0), 0) / samples.length;
  return {
    n: samples.length,
    match: by('match'),
    near: by('near'),
    divergent: by('divergent'),
    matchRate: by('match') / samples.length,
    safeRate: (by('match') + by('near')) / samples.length,
    avgTextSim: avg('textSim'),
    avgReduction: avg('reductionPct'),
    overheadTokens: samples.reduce((a, s) => a + (s.overheadTokens || 0), 0),
    budgetToday: readBudget()
  };
}

export function reset() {
  try { fs.unlinkSync(LOG); } catch {}
  try { fs.unlinkSync(BUDGET); } catch {}
}
