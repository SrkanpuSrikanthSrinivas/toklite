import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = path.join(os.homedir(), '.toklite');
export const CONFIG_PATH = path.join(HOME, 'config.json');

export const DEFAULTS = {
  port: 8787,
  shadow: false,              // true = measure only, send the ORIGINAL request upstream
  reducers: {
    hygiene:     { enabled: true },
    dedupe:      { enabled: true, minChars: 200 },
    compact:     { enabled: true, keepRecentTurns: 6, maxOldBlockChars: 1200, headChars: 500, tailChars: 400 },
    tools:       { enabled: true, minToolChars: 800 },
    cachePoints: { enabled: true },
    terse:       { enabled: false, text: 'Be concise. No preamble, no restating the question, no summary of what you just did.' }
  },
  fidelity: {
    enabled: true,
    sampleRate: 0.01,          // 1% of eligible requests
    maxConcurrent: 2,
    dailyBudgetTokens: 200000, // hard cap on what the audit itself may cost
    matchThreshold: 0.85       // bigram similarity at which text counts as a match
  },
  capture: {
    enabled: false,       // save raw request bodies so savings can be re-verified offline
    max: 200
  },
  counting: {
    enabled: true,        // exact token accounting via the provider
    maxConcurrent: 3,
    minBytes: 0
  },
  cache: {
    enabled: true,
    maxTemperature: 0.3,
    ttlSeconds: 604800,
    maxEntries: 2000
  },
  upstreams: {
    anthropic: 'https://api.anthropic.com',
    openai: 'https://api.openai.com'
  }
};

function deepMerge(base, override) {
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return override ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(override || {})) out[k] = deepMerge(base[k], v);
  return out;
}

export function loadConfig() {
  try {
    return deepMerge(DEFAULTS, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export function saveConfig(cfg) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  return CONFIG_PATH;
}
