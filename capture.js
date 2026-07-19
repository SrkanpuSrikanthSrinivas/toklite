import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './config.js';

export const DIR = path.join(HOME, 'captures');

let n = 0;

/** Store the ORIGINAL request so savings can be re-verified later, offline. */
export function save(body, format, cfg) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const files = fs.readdirSync(DIR);
    if (files.length >= (cfg.capture?.max ?? 200)) return;
    const name = `${Date.now()}-${process.pid}-${n++}.json`;
    fs.writeFileSync(path.join(DIR, name), JSON.stringify({ format, body }));
  } catch {}
}

export function list() {
  try {
    return fs.readdirSync(DIR).filter(f => f.endsWith('.json')).sort()
      .map(f => ({ file: f, ...JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) }));
  } catch { return []; }
}

export function clear() {
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {}
}
