#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { loadConfig, saveConfig, CONFIG_PATH, DEFAULTS } from '../src/config.js';
import { createServer } from '../src/server.js';
import * as store from '../src/store.js';
import * as cache from '../src/cache.js';
import * as fidelity from '../src/fidelity.js';
import * as pricing from '../src/pricing.js';
import * as capture from '../src/capture.js';
import * as counter from '../src/counter.js';
import { reduce } from '../src/reducers.js';
import * as setup from '../src/setup.js';

const argv = process.argv.slice(2);
const cmd = argv[0];

const flag = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  if (i === -1) return fallback;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
};

const c = {
  dim: s => `\x1b[2m${s}\x1b[0m`,
  b: s => `\x1b[1m${s}\x1b[0m`,
  g: s => `\x1b[32m${s}\x1b[0m`,
  y: s => `\x1b[33m${s}\x1b[0m`
};

function startServer({ port, shadow, verbose, silent, audit }) {
  const cfg = loadConfig();
  if (shadow) cfg.shadow = true;
  if (audit) { cfg.fidelity.enabled = true; cfg.fidelity.sampleRate = 1; }
  const server = createServer(cfg, { verbose });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      if (!silent) {
        console.log(`${c.b('toklite')} listening on http://127.0.0.1:${port}  ${cfg.shadow ? c.y('[shadow: measuring only]') : c.g('[active]')}`);
        const on = Object.entries(cfg.reducers).filter(([, v]) => v.enabled).map(([k]) => k).join(', ');
        console.log(c.dim(`  reducers: ${on}`));
        const f = cfg.fidelity;
        console.log(c.dim(`  cache: ${cfg.cache.enabled ? 'on' : 'off'}   fidelity: ${f.enabled ? `${(f.sampleRate * 100).toFixed(f.sampleRate < 0.01 ? 1 : 0)}% sampled` : 'off'}`));
        if (f.enabled && f.sampleRate >= 1) console.log(c.y('  audit mode: EVERY request is replayed uncompressed. This roughly doubles spend.'));
        console.log(c.dim(`  config: ${CONFIG_PATH}`));
      }
      resolve({ server, cfg });
    });
  });
}

async function main() {
  switch (cmd) {
    /* --------------------------------------------------------------- */
    case 'start': {
      const port = Number(flag('port', loadConfig().port));
      await startServer({ port, shadow: argv.includes('--shadow'), audit: argv.includes('--audit'), verbose: !argv.includes('--quiet') });
      console.log('\nPoint your tool at it:');
      console.log(c.dim(`  export ANTHROPIC_BASE_URL=http://127.0.0.1:${port}`));
      console.log(c.dim(`  export OPENAI_BASE_URL=http://127.0.0.1:${port}/v1`));
      console.log(c.dim(`  (or just: toklite run -- <your-cli>)\n`));
      break;
    }

    /* --------------------------------------------------------------- *
     * The main event: wrap any agent CLI with the proxy already wired. *
     * --------------------------------------------------------------- */
    case 'run': {
      const sep = argv.indexOf('--');
      if (sep === -1 || !argv[sep + 1]) {
        console.error('usage: toklite run [--port N] [--shadow] -- <command> [args...]');
        process.exit(1);
      }
      const port = Number(flag('port', loadConfig().port));
      const { server } = await startServer({
        port,
        shadow: argv.includes('--shadow'),
        audit: argv.includes('--audit'),
        verbose: argv.includes('--verbose')
      });

      const [bin, ...rest] = argv.slice(sep + 1);

      // Claude Code signs in with claude.ai OAuth by default, and Anthropic
      // rejects those tokens whenever ANTHROPIC_BASE_URL points anywhere other
      // than api.anthropic.com — proxy included. The failure surfaces as
      // "401 OAuth access token has been revoked", which reads like a broken
      // login rather than a configuration rule, so warn before it happens.
      const looksLikeClaudeCode = /(^|\/)claude$/.test(bin);
      const hasApiKey = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
      if (looksLikeClaudeCode && !hasApiKey) {
        console.log(c.y('\n  Heads up: Claude Code signed in with a claude.ai subscription cannot'));
        console.log(c.y('  authenticate through any proxy. Anthropic rejects OAuth tokens when'));
        console.log(c.y('  ANTHROPIC_BASE_URL is not api.anthropic.com, and you will see'));
        console.log(c.y('  "401 OAuth access token has been revoked".'));
        console.log(c.dim('\n  To use toklite with Claude Code, authenticate with an API key instead:'));
        console.log(c.dim('    export ANTHROPIC_API_KEY=sk-ant-...'));
        console.log(c.dim('\n  Note that subscription usage is not billed per token, so there is no'));
        console.log(c.dim('  per-token cost for toklite to reduce there in the first place. It pays'));
        console.log(c.dim('  off on metered API-key traffic: Kiro, Cursor, SDK apps, your own agents.\n'));
      }

      const child = spawn(bin, rest, {
        stdio: 'inherit',
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
          ANTHROPIC_API_BASE: `http://127.0.0.1:${port}`,
          OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
          OPENAI_API_BASE: `http://127.0.0.1:${port}/v1`
        }
      });
      child.on('exit', (code) => {
        server.close();
        printStats(store.read(), true);
        process.exit(code ?? 0);
      });
      break;
    }

    /* --------------------------------------------------------------- */
    case 'stats':
      if (argv.includes('--reset')) { store.reset(); console.log('stats reset'); break; }
      printStats(store.read());
      break;

    case 'config': {
      const cfg = loadConfig();
      if (argv[1] === 'init') { console.log('wrote', saveConfig(DEFAULTS)); break; }
      if (argv[1] === 'set') {
        const [pathExpr, value] = argv.slice(2);
        if (!pathExpr) { console.error('usage: toklite config set <a.b.c> <value>'); process.exit(1); }
        const parts = pathExpr.split('.');
        let node = cfg;
        for (const p of parts.slice(0, -1)) node = node[p] ??= {};
        node[parts.at(-1)] = value === 'true' ? true : value === 'false' ? false : isNaN(Number(value)) ? value : Number(value);
        console.log('wrote', saveConfig(cfg));
        break;
      }
      console.log(JSON.stringify(cfg, null, 2));
      break;
    }

    case 'fidelity': {
      if (argv[1] === 'reset') { fidelity.reset(); console.log('fidelity log reset'); break; }
      const samples = fidelity.readSamples();
      const sum = fidelity.summarize(samples);
      if (!sum) {
        console.log('No fidelity samples yet.');
        console.log(c.dim('  Default sampling is 1% of requests. To calibrate deliberately:'));
        console.log(c.dim('    toklite run --audit --verbose -- claude'));
        break;
      }
      const pct = n => (n * 100).toFixed(1) + '%';
      console.log(c.b('toklite fidelity'));
      console.log(`  samples         ${sum.n}`);
      console.log(`  matched         ${sum.match}  ${c.g(pct(sum.matchRate))}`);
      console.log(`  near-match      ${sum.near}`);
      console.log(`  divergent       ${sum.divergent}  ${sum.divergent ? c.y(pct(sum.divergent / sum.n)) : ''}`);
      console.log(`  avg similarity  ${sum.avgTextSim.toFixed(3)}`);
      console.log(`  avg reduction   -${sum.avgReduction.toFixed(1)}% on audited requests`);
      console.log(c.dim(`  audit overhead  ~${sum.overheadTokens.toLocaleString()} tokens spent verifying (today: ${sum.budgetToday.spent.toLocaleString()})`));
      console.log('\n  ' + c.b(`Headline: -${sum.avgReduction.toFixed(0)}% tokens, answers matched ${pct(sum.matchRate)} of the time (n=${sum.n}).`));

      const bad = samples.filter(s => s.verdict === 'divergent').slice(-Number(flag('show', 3)));
      if (bad.length) {
        console.log('\n' + c.y('  worst divergences:'));
        for (const b of bad) {
          console.log(c.dim(`    ${b.t}  sim=${b.textSim.toFixed(2)}  ${b.reason}  (reduced -${b.reductionPct}%)`));
          console.log(c.dim(`      reduced : ${b.reducedText.slice(0, 110).replace(/\n/g, ' ')}`));
          console.log(c.dim(`      original: ${b.originalText.slice(0, 110).replace(/\n/g, ' ')}`));
        }
        console.log(c.dim('\n    If divergences cluster, the usual culprit is compact. Try:'));
        console.log(c.dim('      toklite config set reducers.compact.keepRecentTurns 12'));
      }
      break;
    }

    /* --------------------------------------------------------------- *
     * verify — independent proof, at zero cost.
     *
     * Takes captured requests, counts each one BOTH ways against the
     * provider's own free counting endpoint, and prints the difference.
     * No inference is run, so this cannot be gamed by anything toklite
     * does at request time, and it costs nothing to execute.
     * --------------------------------------------------------------- */
    /* --------------------------------------------------------------- *
     * setup — tell the user exactly what their machine needs.
     * --------------------------------------------------------------- */
    case 'setup': {
      const cfg = loadConfig();
      const port = Number(flag('port', cfg.port));
      const shell = setup.detectShell();
      const profile = setup.profilePath(shell);
      const binDir = setup.globalBinDir();
      const onPath = setup.isOnPath(binDir);
      const resolves = setup.commandResolves('toklite');
      const keys = setup.apiKeyStatus();
      const free = await setup.portFree(port);

      console.log(c.b('toklite setup'));
      console.log(`  shell           ${shell}`);
      console.log(`  profile         ${profile}`);
      console.log(`  node            ${process.version}`);
      console.log(`  global bin      ${binDir || c.y('could not determine (is npm on PATH?)')}`);
      console.log(`  on your PATH    ${onPath ? c.g('yes') : c.y('NO')}`);
      console.log(`  command works   ${resolves ? c.g('yes') : c.y('no')}`);
      console.log(`  port ${String(port).padEnd(10)} ${free ? c.g('free') : c.y('in use — pick another with --port')}`);
      console.log(`  config          ${CONFIG_PATH}`);
      console.log(`  API keys seen   ${keys.anthropic ? c.g('ANTHROPIC_API_KEY') : c.dim('ANTHROPIC_API_KEY not set')}` +
      `  ${keys.openai ? c.g('OPENAI_API_KEY') : c.dim('OPENAI_API_KEY not set')}`);

      const lines = [];
      if (binDir && !onPath) lines.push(setup.pathLine(binDir, shell));

      if (argv.includes('--write')) {
        if (!lines.length) {
          console.log(c.g('\n  Nothing to fix: the command already resolves.'));
        } else {
          const r = setup.writeProfile(lines, { shell });
          console.log(c.g(`\n  ${r.action} a toklite block in ${r.target}`));
          console.log(`  Run: ${c.b(`source ${r.target}`)}   (or open a new terminal)`);
        }
        saveConfig(cfg);
        console.log(c.dim(`  wrote defaults to ${CONFIG_PATH}`));
        break;
      }

      if (!lines.length && !resolves) {
        console.log(c.y('\n  The global bin directory is already on your PATH, so nothing needs'));
        console.log(c.y('  fixing here — toklite just is not installed globally yet:'));
        console.log(`\n    ${c.b('npm i -g toklite')}\n`);
        console.log(c.dim('  If you use nvm, global installs live under the active Node version.'));
        console.log(c.dim('  Switching Node versions hides them until you reinstall.'));
      }

      if (lines.length) {
        console.log(c.y('\n  Your PATH is missing npm\'s global bin directory, which is why'));
        console.log(c.y('  `toklite` is not found. Add this line:'));
        console.log(`\n    ${lines.join('\n    ')}\n`);
        console.log(`  or let toklite do it:  ${c.b('toklite setup --write')}`);
      }

      console.log(c.b('\n  Connecting a tool'));
      console.log('  Preferred — no profile changes, nothing to undo:');
      console.log(`    ${c.b('toklite run -- claude')}`);
      console.log(c.dim('    starts the proxy, points the child process at it, cleans up on exit'));
      console.log('\n  Or set the variables yourself, for tools that will not inherit them:');
      for (const l of setup.baseUrlLines(port, shell)) console.log(c.dim(`    ${l}`));
      console.log(c.y('\n  Do not put those two lines in your shell profile permanently.'));
      console.log(c.y('  They route every tool through a proxy that may not be running, and'));
      console.log(c.y('  calls will fail when it is not. Export them per-session instead.'));
      console.log(c.dim('\n  Your API key is never read or stored by toklite; it is forwarded'));
      console.log(c.dim('  from the client to the provider untouched. `toklite verify` is the'));
      console.log(c.dim('  one exception: it reads ANTHROPIC_API_KEY to call the free counter.'));
      break;
    }

    case 'verify': {
      const cfg = loadConfig();
      const upstream = String(flag('upstream', cfg.upstreams.anthropic));
      const key = flag('key', process.env.ANTHROPIC_API_KEY);
      const single = flag('file', null);

      const items = single
      ? [{ file: String(single), format: 'anthropic', body: JSON.parse(await (await import('node:fs')).readFileSync(String(single), 'utf8')) }]
      : capture.list();

      if (!items.length) {
        console.log('Nothing captured yet. Record some real traffic first:');
        console.log(c.dim('  toklite config set capture.enabled true'));
        console.log(c.dim('  toklite run -- claude          # do a normal session'));
        console.log(c.dim('  toklite verify'));
        break;
      }

      const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
      if (key && key !== true) headers['x-api-key'] = String(key);

      console.log(c.b(`Verifying ${items.length} captured request(s) against ${upstream}`));
      console.log(c.dim('  Counting each one twice with the provider\'s free count_tokens endpoint.'));
      console.log(c.dim('  No inference is run. This costs nothing.\n'));

      let sumBefore = 0, sumAfter = 0, ok = 0, failed = 0;
      const perModel = {};

      for (const item of items) {
        if (item.format !== 'anthropic') { failed++; continue; }
        const original = item.body;
        const { body: reduced } = reduce(original, 'anthropic', cfg);

        const a = await counter.countAnthropic(original, headers, upstream, cfg);
        const b = await counter.countAnthropic(reduced, headers, upstream, cfg);
        if (!a?.tokens || typeof b?.tokens !== 'number') {
          failed++;
          if (failed === 1) console.log(c.y(`  could not count: ${a?.reason || b?.reason || 'unknown'}`));
          continue;
        }
        ok++;
        sumBefore += a.tokens;
        sumAfter += b.tokens;
        const m = original.model || 'unknown';
        perModel[m] = perModel[m] || { before: 0, after: 0, n: 0 };
        perModel[m].before += a.tokens;
        perModel[m].after += b.tokens;
        perModel[m].n++;

        const pct = Math.round(((a.tokens - b.tokens) / a.tokens) * 100);
        console.log(`  ${String(a.tokens).padStart(8)} -> ${String(b.tokens).padStart(8)} tokens  ${(pct >= 0 ? '-' : '+') + Math.abs(pct) + '%'}`);
      }

      if (!ok) { console.log(c.y('\n  Nothing could be verified. Check that the API key is valid.')); break; }

      const saved = sumBefore - sumAfter;
      const pct = ((saved / sumBefore) * 100).toFixed(1);
      console.log(c.b(`\n  ${sumBefore.toLocaleString()} -> ${sumAfter.toLocaleString()} input tokens across ${ok} request(s)`));
      console.log(c.b(`  saved ${saved.toLocaleString()} tokens ${c.g(`(-${pct}%)`)}`));

      let money = 0;
      for (const [model, v] of Object.entries(perModel)) {
        const r = pricing.rates(model, cfg);
        if (r) money += (v.before - v.after) * r.in / 1e6;
      }
      if (money) console.log(c.b(`  worth ${pricing.usd(money)} at ${pricing.PRICING_DATE} input rates, on this sample alone`));
      if (failed) console.log(c.dim(`  ${failed} request(s) skipped (unsupported format or count failed)`));
      console.log(c.dim('\n  Cross-check it yourself: the same endpoint is a plain curl away, and'));
      console.log(c.dim('  your provider console shows the billed totals independently.'));
      break;
    }

    case 'pricing': {
      const cfg = loadConfig();
      console.log(c.b('toklite pricing') + c.dim(`   rates as of ${pricing.PRICING_DATE}, USD per million tokens`));
      const table = { ...pricing.TABLE, ...(cfg.pricing || {}) };
      for (const [model, r] of Object.entries(table)) {
        console.log(`  ${model.padEnd(20)} in $${String(r.in).padStart(6)}   out $${String(r.out).padStart(6)}` +
        c.dim(`   cache read $${(r.in * pricing.CACHE_READ_MULT).toFixed(2)}  write $${(r.in * pricing.CACHE_WRITE_MULT).toFixed(2)}`));
      }
      console.log(c.dim('\n  Prices move. Override any model:'));
      console.log(c.dim('    toklite config set pricing.claude-sonnet-5.in 2'));
      break;
    }

    case 'cache':
      if (argv[1] === 'clear') { cache.clear(); console.log('cache cleared'); }
      else console.error('usage: toklite cache clear');
      break;

    case 'doctor': {
      const binDir = setup.globalBinDir();
      const resolves = setup.commandResolves('toklite');
      const binOnPath = setup.isOnPath(binDir);
      // Distinguish "never installed globally" from "installed but PATH is
      // wrong". They need opposite fixes, and conflating them sends people
      // editing shell profiles over an install that simply never happened.
      const verdict = resolves ? c.g('yes')
      : binOnPath ? c.y('no — installed locally only. Run: npm i -g toklite')
      : c.y('no — the global bin directory is not on your PATH. Run: toklite setup --write');
      console.log(c.b('environment'));
      console.log(`  node ${process.version}  ${Number(process.version.slice(1).split('.')[0]) >= 20 ? c.g('ok') : c.y('needs >= 20')}`);
      console.log(`  toklite command: ${verdict}`);
      console.log(c.dim(`  global bin: ${binDir || 'unknown'}`));
      console.log(c.dim(`  config: ${CONFIG_PATH}`));
      console.log();

      const port = Number(flag('port', loadConfig().port));
      const { server } = await startServer({ port: port + 1, verbose: false, silent: true });
      // A realistic agent transcript: one non-repeating source file, read
      // early, re-read later, plus tool schemas resent every turn.
      const FILE = `import { db } from './db.js';
import { NotFoundError, ValidationError } from './errors.js';
import { cache } from './cache.js';

const PROFILE_TTL = 300;

export async function loadUserProfile(userId, options = {}) {
  const { includeOrders = false, includePreferences = true } = options;
  const cached = await cache.get(\`profile:\${userId}\`);
  if (cached) return cached;
  const profile = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
  if (!profile.rows.length) throw new NotFoundError('user not found: ' + userId);
  const result = { ...profile.rows[0] };
  if (includeOrders) result.orders = await loadOrders(userId);
  if (includePreferences) result.preferences = await loadPreferences(userId);
  await cache.set(\`profile:\${userId}\`, result, PROFILE_TTL);
  return result;
}

async function loadOrders(userId) {
  const { rows } = await db.query(
    'SELECT id, total_cents, status, placed_at FROM orders WHERE user_id = $1 ORDER BY placed_at DESC LIMIT 50',
    [userId]
  );
  return rows.map(r => ({ ...r, total: r.total_cents / 100 }));
}

async function loadPreferences(userId) {
  const { rows } = await db.query('SELECT key, value FROM preferences WHERE user_id = $1', [userId]);
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

export async function updateProfile(userId, patch) {
  if (!patch || typeof patch !== 'object') throw new ValidationError('patch must be an object');
  const allowed = ['display_name', 'email', 'locale', 'timezone'];
  const entries = Object.entries(patch).filter(([k]) => allowed.includes(k));
  if (!entries.length) throw new ValidationError('no updatable fields supplied');
  const sets = entries.map(([k], i) => \`\${k} = $\${i + 2}\`).join(', ');
  await db.query(\`UPDATE users SET \${sets} WHERE id = $1\`, [userId, ...entries.map(([, v]) => v)]);
  await cache.del(\`profile:\${userId}\`);
  return loadUserProfile(userId, { includePreferences: true });
}
`;

const LOG = Array.from({ length: 30 }, (_, i) =>
`2026-07-18T09:${String(i).padStart(2, '0')}:11Z  DEBUG  pool acquire conn=${i % 8} waiters=${i % 3} elapsed=${i * 7}ms`
).join('\n');

const probe = {
model: 'claude-sonnet-4-5',
max_tokens: 1024,
system: 'You are a coding agent operating in a repository. Follow the user instructions carefully and use the provided tools to inspect and modify files.   \n\n\n\n\n' + '='.repeat(60) + '\n',
tools: [
{ name: 'read_file', description: 'Read a file from the workspace and return its contents as a string. This tool should be preferred over shell commands such as cat because it handles encoding correctly and applies workspace path resolution rules consistently across platforms.', input_schema: { type: 'object', properties: { path: { type: 'string', description: 'Absolute or workspace-relative path to the file that should be read from disk, resolved against the workspace root when relative.' } } } },
{ name: 'write_file', description: 'Write content to a file, creating parent directories as needed. Overwrites any existing file at that path without prompting, so callers should read first when they intend to preserve prior content.', input_schema: { type: 'object', properties: { path: { type: 'string', description: 'Destination path for the file that will be written, resolved against the workspace root when relative.' }, content: { type: 'string', description: 'The full textual content to write to the destination file, replacing whatever was there before.' } } } },
{ name: 'run_tests', description: 'Execute the project test suite and return the results, including failures with their stack traces, so that regressions introduced by an edit can be identified before the change is reported as complete.', input_schema: { type: 'object', properties: { pattern: { type: 'string', description: 'Optional glob restricting which test files are executed during this run of the suite.' } } } }
],
messages: [
{ role: 'user', content: 'Read src/profile.js and tell me what it does.' },
{ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'src/profile.js' } }] },
{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: FILE }] }] },
{ role: 'assistant', content: 'It loads and updates user profiles, with a cache layer in front of Postgres.' },
{ role: 'user', content: 'Here are the debug logs from the failing run:\n' + LOG },
{ role: 'assistant', content: 'The pool is saturating.' },
{ role: 'user', content: 'Re-read the file and add error handling to loadPreferences.' },
{ role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'read_file', input: { path: 'src/profile.js' } }] },
{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: FILE }] }] }
]
};
const { reduce } = await import('../src/reducers.js');
const beforeBytes = Buffer.byteLength(JSON.stringify(probe));
const { body, report } = reduce(probe, 'anthropic', loadConfig());
const afterBytes = Buffer.byteLength(JSON.stringify(body));
const pct = Math.round((1 - afterBytes / beforeBytes) * 100);
console.log(`${c.b('self-test')}  ${beforeBytes.toLocaleString()} -> ${afterBytes.toLocaleString()} bytes (${pct >= 0 ? '-' : '+'}${Math.abs(pct)}%)`);
for (const r of report) console.log(c.dim(`  ${r.name.padEnd(12)} removed ${(r.chars || 0).toLocaleString()} chars${r.marked ? `, ${r.marked} cache breakpoint(s)` : ''}`));
console.log(c.dim('\n  Bytes are exact but are not tokens. Real token and cost figures come from'));
console.log(c.dim('  the provider once traffic flows: run a session, then `toklite stats`.'));
server.close();
break;
}

default:
console.log(`${c.b('toklite')} — cut LLM tokens before the request leaves your machine

  toklite setup                check this machine and print what to configure
  toklite run -- <command>     start the proxy and launch a tool through it
  toklite start                run the proxy on its own
  toklite stats                what you have saved so far
  toklite config [set k v]     view or change settings
  toklite fidelity             did reduction change the answers?
  toklite verify               prove the saving against the provider, free
  toklite pricing              model rates used for cost figures
  toklite cache clear          drop the response cache
  toklite doctor               self-test the reduction pipeline

  flags:  --port N   --verbose
          --shadow    measure only; originals go upstream untouched
          --audit     replay every request uncompressed and score divergence

  examples:
    toklite run -- claude
    toklite run --verbose -- kiro
    toklite run --shadow -- npm run my-agent
    toklite run --audit --verbose -- claude    # calibration run
    toklite verify                             # zero-cost proof of savings
`);
}
}

function printStats(s, footer = false) {
const line = footer ? '\n' + c.b('toklite session summary') : c.b('toklite stats');
console.log(line);
console.log(`  requests        ${s.requests}   (cache hits: ${s.cacheHits})`);

if (!s.measured) {
console.log(c.y('  no exactly measured requests yet'));
const reasons = Object.entries(s.unmeasuredReasons || {});
if (reasons.length) {
console.log(c.dim('  could not measure:'));
for (const [r, n] of reasons) console.log(c.dim(`    ${n}x  ${r}`));
}
console.log(c.dim('  toklite reports provider-verified numbers only. It will not print an estimate.'));
return;
}

const saved = s.tokensBefore - s.tokensAfter;
const pct = s.tokensBefore ? ((saved / s.tokensBefore) * 100).toFixed(1) : '0.0';
const costSaved = s.costBaseline - s.costActual;
const coverage = ((s.measured / (s.measured + s.unmeasured)) * 100).toFixed(0);

console.log(c.b('\n  exact — counted by the provider, not estimated'));
console.log(`    input without toklite   ${s.tokensBefore.toLocaleString()} tokens`);
console.log(`    input actually billed   ${s.tokensAfter.toLocaleString()} tokens`);
console.log(`    saved                   ${saved.toLocaleString()} tokens  ${c.g(`(-${pct}%)`)}`);
console.log(`    output billed           ${s.outputTokens.toLocaleString()} tokens`);
if (s.cacheReadTokens || s.cacheWriteTokens) {
console.log(c.dim(`    of billed input: ${s.cacheReadTokens.toLocaleString()} read from prompt cache, ${s.cacheWriteTokens.toLocaleString()} written to it`));
}

console.log(c.b('\n  money'));
console.log(`    would have cost         ${pricing.usd(s.costBaseline)}`);
console.log(`    actually cost           ${pricing.usd(s.costActual)}`);
console.log(`    saved                   ${c.g(pricing.usd(costSaved))}`);
console.log(c.dim(`    rates as of ${pricing.PRICING_DATE}; override any model under "pricing" in config`));

console.log(c.dim(`\n  measured ${s.measured}/${s.measured + s.unmeasured} requests (${coverage}%)`));
const reasons = Object.entries(s.unmeasuredReasons || {});
for (const [r, n] of reasons) console.log(c.dim(`    unmeasured: ${n}x ${r}`));

const chars = Object.entries(s.charsRemoved || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
if (chars.length) {
const total = chars.reduce((a, [, v]) => a + v, 0);
console.log(c.dim('\n  bytes removed by each layer (exact; token saving apportioned by share)'));
for (const [k, v] of chars) {
const share = Math.round((v / total) * 100);
console.log(c.dim(`    ${k.padEnd(12)} ${v.toLocaleString()} chars  ~${share}% of the reduction`));
}
}
if (s.shadowRequests) console.log(c.y(`\n  ${s.shadowRequests} request(s) ran in shadow mode: measured, not altered.`));
}

main();