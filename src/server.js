import http from 'node:http';
import { detectFormat, cacheSignature } from './adapters.js';
import { reduce } from './reducers.js';
import * as counter from './counter.js';
import * as pricing from './pricing.js';
import * as capture from './capture.js';
import * as cache from './cache.js';
import * as store from './store.js';
import * as fidelity from './fidelity.js';

const HOP_HEADERS = new Set([
  'host', 'connection', 'content-length', 'accept-encoding',
  'transfer-encoding', 'keep-alive', 'upgrade'
]);

function forwardHeaders(incoming) {
  const out = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (!HOP_HEADERS.has(k.toLowerCase())) out[k] = v;
  }
  out['accept-encoding'] = 'identity';
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Pull the usage object out of a non-streamed response of either format. */
function usageOf(json) {
  if (!json) return null;
  if (json.usage) {
    const u = json.usage;
    return {
      input_tokens: u.input_tokens ?? u.prompt_tokens ?? 0,
      output_tokens: u.output_tokens ?? u.completion_tokens ?? 0,
      cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0
    };
  }
  return null;
}

/** Scrape usage out of an SSE byte stream without disturbing the passthrough. */
function scrapeStreamUsage(text) {
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const j = JSON.parse(payload);
      const u = j.usage || j.message?.usage;
      if (!u) continue;
      usage.input_tokens = Math.max(usage.input_tokens, u.input_tokens ?? u.prompt_tokens ?? 0);
      usage.output_tokens = Math.max(usage.output_tokens, u.output_tokens ?? u.completion_tokens ?? 0);
      usage.cache_read_input_tokens = Math.max(usage.cache_read_input_tokens, u.cache_read_input_tokens ?? 0);
      usage.cache_creation_input_tokens = Math.max(usage.cache_creation_input_tokens, u.cache_creation_input_tokens ?? 0);
    } catch {}
  }
  return usage;
}

export function createServer(cfg, opts = {}) {
  const verbose = opts.verbose;

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/__toklite/stats') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(store.read(), null, 2));
    }
    if (url.pathname === '/__toklite/fidelity') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(fidelity.summarize(fidelity.readSamples()) ?? { n: 0 }, null, 2));
    }
    if (url.pathname === '/__toklite/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, shadow: cfg.shadow }));
    }

    const format = detectFormat(url.pathname);
    const upstreamBase = req.headers['x-toklite-upstream']
    || (format === 'openai' ? cfg.upstreams.openai : cfg.upstreams.anthropic);

    const raw = await readBody(req);

    // Anything that is not a recognised completion call is a plain passthrough.
    if (!format || req.method !== 'POST') {
      return passthrough(req, res, upstreamBase + url.pathname + url.search, raw, {});
    }

    let original;
    try { original = JSON.parse(raw.toString('utf8')); }
    catch { return passthrough(req, res, upstreamBase + url.pathname + url.search, raw, {}); }

    if (cfg.capture?.enabled) capture.save(original, format, cfg);

    // reduce() is async (image downscaling awaits sharp). A missing await here
    // was the 0.3.x crash: destructuring a Promise yields undefined report.
    // The try/catch is belt-and-suspenders — if any reducer throws, we must
    // still forward the ORIGINAL request rather than drop the user's traffic.
    let reduced, report;
    try {
      ({ body: reduced, report } = await reduce(original, format, cfg));
    } catch (err) {
      if (verbose) console.error('  reduce failed, forwarding original:', err.message);
      reduced = original;
      report = [];
    }
    const toSend = cfg.shadow ? original : reduced;
    const bytesRemoved = (report || []).reduce((a, r) => a + (r.chars || 0), 0);

    const meta = {
      'x-toklite-bytes-removed': String(bytesRemoved),
      'x-toklite-mode': cfg.shadow ? 'shadow' : 'active'
    };

    // ---- cache lookup -------------------------------------------------
    const sig = cacheSignature(reduced, format);
    const wantsStream = !!toSend.stream;
    if (cache.cacheable(reduced, cfg)) {
      const hit = cache.get(sig, cfg);
      if (hit) {
        store.recordRequest({ cacheHit: true, shadow: cfg.shadow, report, model: original.model });
        // Nothing was sent upstream, so the exact saving is the full cost of
        // the original request. Measured, not assumed.
        measure({ original, format, headers: req.headers, upstreamBase, usage: null,
          cacheHit: true, cfg, verbose });
        if (verbose) console.log('  cache HIT — request never left the machine');
        if (wantsStream) {
          res.writeHead(200, { ...meta, 'x-toklite-cache': 'hit', 'content-type': 'text/event-stream' });
          return res.end(cache.toSSE(hit, format));
        }
        res.writeHead(200, { ...meta, 'x-toklite-cache': 'hit', 'content-type': 'application/json' });
        return res.end(JSON.stringify(hit));
      }
    }

    // ---- forward ------------------------------------------------------
    const upstreamUrl = upstreamBase + url.pathname + url.search;
    const auditWanted = fidelity.shouldSample(cfg, { cacheHit: false, bytes: payloadBytes(toSend) });
    store.recordRequest({ cacheHit: false, shadow: cfg.shadow, report, model: original.model });
    const payload = Buffer.from(JSON.stringify(toSend));
    const upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: { ...forwardHeaders(req.headers), 'content-type': 'application/json' },
      body: payload
    }).catch(err => ({ error: err }));

    if (upstream.error) {
      res.writeHead(502, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { type: 'toklite_upstream_error', message: String(upstream.error) } }));
    }

    const outHeaders = { ...meta, 'x-toklite-cache': 'miss' };
    for (const [k, v] of upstream.headers) {
      if (!HOP_HEADERS.has(k.toLowerCase())) outHeaders[k] = v;
    }
    res.writeHead(upstream.status, outHeaders);

    const isStream = (upstream.headers.get('content-type') || '').includes('event-stream');

    if (isStream) {
      const collected = [];
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        collected.push(Buffer.from(value));
        res.write(Buffer.from(value));
      }
      res.end();
      const text = Buffer.concat(collected).toString('utf8');
      const usage = scrapeStreamUsage(text);
      measure({ original, format, headers: req.headers, upstreamBase, usage, cacheHit: false, cfg, verbose });
      if (auditWanted) {
        audit(upstreamUrl, req.headers, original, format,
          fidelity.extractStreamOutput(text, format), bytesRemoved, cfg, verbose);
      }
      return;
    }

    const text = await upstream.text();
    res.end(text);
    let json = null;
    try { json = JSON.parse(text); } catch {}
    if (json && upstream.status === 200 && cache.cacheable(reduced, cfg)) cache.put(sig, json, cfg);
    const usage = usageOf(json);
    measure({ original, format, headers: req.headers, upstreamBase, usage, cacheHit: false, cfg, verbose });
    if (auditWanted && json) {
      audit(upstreamUrl, req.headers, original, format,
        fidelity.extractOutput(json, format), bytesRemoved, cfg, verbose);
    }
  });
}

/** Fire-and-forget. The client already has its answer; this only measures. */
function audit(url, headers, originalBody, format, reducedOutput, bytesRemoved, cfg, verbose) {
  fidelity.runCheck({
    url,
    headers: forwardHeaders(headers),
    originalBody, format, reducedOutput, bytesRemoved, cfg,
    onDone: (rec) => {
      if (!verbose) return;
      const mark = rec.verdict === 'match' ? '\x1b[32mmatch\x1b[0m'
      : rec.verdict === 'near' ? '\x1b[33mnear\x1b[0m'
      : '\x1b[31mDIVERGENT\x1b[0m';
      console.log(`  fidelity ${mark}  sim=${rec.textSim.toFixed(2)}  ${rec.reason}  (audit cost ~${rec.overheadTokens} tok)`);
    }
  });
}

function payloadBytes(body) {
  return Buffer.byteLength(JSON.stringify(body || {}));
}

/**
 * Exact accounting, run after the client already has its answer.
 *
 *   after  = what the provider actually billed for this request (usage block)
 *   before = what the unreduced request would have cost, from the provider's
 *            own free counting endpoint
 *
 * If either number is unavailable the request is recorded as UNMEASURED.
 * Nothing is ever inferred from character counts or heuristics.
 */
async function measure({ original, format, headers, upstreamBase, usage, cacheHit, cfg, verbose }) {
  if (cfg.counting?.enabled === false) return;
  if (payloadBytes(original) < (cfg.counting?.minBytes ?? 0)) return;

  const after = cacheHit ? 0 : counter.billedInput(usage);
  const counted = await counter.countExact(original, format, forwardHeaders(headers), upstreamBase, cfg);
  const before = counted?.tokens ?? null;

  if (before === null || after === null) {
    store.recordMeasurement({
      model: original.model, before: null, after: null,
      method: counted?.method || 'unmeasured',
      reason: counted?.reason || (after === null ? 'no usage in response' : 'no count available')
    });
    if (verbose) console.log(`  \x1b[2munmeasured: ${counted?.reason || 'provider returned no usage'}\x1b[0m`);
    return;
  }

  const costActual = cacheHit ? 0 : pricing.actualCost(original.model, usage, cfg);
  const costBaseline = pricing.baselineCost(original.model, before, usage?.output_tokens || 0, cfg);

  store.recordMeasurement({
    model: original.model, before, after, method: counted.method,
    usage, costActual, costBaseline
  });

  if (verbose) {
    const pct = before ? Math.round(((before - after) / before) * 100) : 0;
    const money = (costBaseline !== null && costActual !== null)
    ? `  saved ${pricing.usd(costBaseline - costActual)}` : '';
    console.log(`  ${before} -> ${after} tokens (-${pct}%) exact via ${counted.method}${money}`);
  }
}

function passthrough(req, res, target, body, extra) {
  fetch(target, {
    method: req.method,
    headers: forwardHeaders(req.headers),
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : body
  }).then(async (up) => {
    const h = { ...extra };
    for (const [k, v] of up.headers) if (!HOP_HEADERS.has(k.toLowerCase())) h[k] = v;
    res.writeHead(up.status, h);
    res.end(Buffer.from(await up.arrayBuffer()));
  }).catch(err => {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'toklite_upstream_error', message: String(err) } }));
  });
}