import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOME } from './config.js';

const DIR = path.join(HOME, 'cache');

const key = (sig) => crypto.createHash('sha256').update(sig).digest('hex');

export function get(sig, cfg) {
  if (!cfg.cache.enabled) return null;
  const file = path.join(DIR, key(sig) + '.json');
  try {
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Date.now() - entry.at > cfg.cache.ttlSeconds * 1000) {
      fs.unlinkSync(file);
      return null;
    }
    return entry.body;
  } catch {
    return null;
  }
}

export function put(sig, body, cfg) {
  if (!cfg.cache.enabled) return;
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, key(sig) + '.json'), JSON.stringify({ at: Date.now(), body }));
  prune(cfg.cache.maxEntries);
}

export function cacheable(body, cfg) {
  if (!cfg.cache.enabled) return false;
  const temp = body.temperature;
  if (temp !== undefined && temp > cfg.cache.maxTemperature) return false;
  return true;
}

function prune(max) {
  try {
    const files = fs.readdirSync(DIR).map(f => {
      const p = path.join(DIR, f);
      return { p, t: fs.statSync(p).mtimeMs };
    });
    if (files.length <= max) return;
    files.sort((a, b) => a.t - b.t).slice(0, files.length - max)
      .forEach(f => { try { fs.unlinkSync(f.p); } catch {} });
  } catch {}
}

export function clear() {
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {}
}

/* ---- replay a cached JSON response as a stream, so streaming clients
        (which is most agent CLIs) can still benefit from the cache ---- */
export function toSSE(body, format) {
  const out = [];
  const ev = (event, data) =>
    out.push(format === 'anthropic'
      ? `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
      : `data: ${JSON.stringify(data)}\n\n`);

  if (format === 'anthropic') {
    const text = (body.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    ev('message_start', { type: 'message_start', message: { ...body, content: [] } });
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
    ev('content_block_stop', { type: 'content_block_stop', index: 0 });
    ev('message_delta', { type: 'message_delta', delta: { stop_reason: body.stop_reason ?? 'end_turn' }, usage: body.usage || {} });
    ev('message_stop', { type: 'message_stop' });
  } else {
    const text = body.choices?.[0]?.message?.content ?? '';
    const base = { id: body.id, object: 'chat.completion.chunk', created: body.created, model: body.model };
    ev('', { ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
    ev('', { ...base, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
    ev('', { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    out.push('data: [DONE]\n\n');
  }
  return out.join('');
}
