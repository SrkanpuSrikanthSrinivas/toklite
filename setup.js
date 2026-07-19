import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const MARK_START = '# >>> toklite >>>';
const MARK_END = '# <<< toklite <<<';

export function detectShell() {
  const sh = path.basename(process.env.SHELL || '');
  if (sh.includes('fish')) return 'fish';
  if (sh.includes('zsh')) return 'zsh';
  if (sh.includes('bash')) return 'bash';
  return sh || 'sh';
}

export function profilePath(shell = detectShell()) {
  const home = os.homedir();
  if (shell === 'fish') return path.join(home, '.config', 'fish', 'config.fish');
  if (shell === 'zsh') return path.join(home, '.zshrc');
  if (shell === 'bash') {
    // macOS login shells read .bash_profile; Linux reads .bashrc.
    const bp = path.join(home, '.bash_profile');
    if (process.platform === 'darwin' || fs.existsSync(bp)) return bp;
    return path.join(home, '.bashrc');
  }
  return path.join(home, '.profile');
}

/** Where npm puts global command symlinks. */
export function globalBinDir() {
  try {
    const prefix = execFileSync('npm', ['prefix', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return process.platform === 'win32' ? prefix : path.join(prefix, 'bin');
  } catch { return null; }
}

export function isOnPath(dir) {
  if (!dir) return false;
  const sep = process.platform === 'win32' ? ';' : ':';
  return (process.env.PATH || '').split(sep).map(p => p.replace(/\/$/, '')).includes(dir.replace(/\/$/, ''));
}

export function commandResolves(cmd = 'toklite') {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

export function pathLine(dir, shell = detectShell()) {
  return shell === 'fish'
    ? `fish_add_path ${dir}`
    : `export PATH="${dir}:$PATH"`;
}

export function baseUrlLines(port, shell = detectShell()) {
  const vars = [
    ['ANTHROPIC_BASE_URL', `http://127.0.0.1:${port}`],
    ['OPENAI_BASE_URL', `http://127.0.0.1:${port}/v1`]
  ];
  return vars.map(([k, v]) => (shell === 'fish' ? `set -gx ${k} ${v}` : `export ${k}="${v}"`));
}

/** Append a marked, idempotent block to the user's shell profile. */
export function writeProfile(lines, { shell = detectShell(), file = null } = {}) {
  const target = file || profilePath(shell);
  let existing = '';
  try { existing = fs.readFileSync(target, 'utf8'); } catch {}

  if (existing.includes(MARK_START)) {
    const re = new RegExp(`${MARK_START}[\\s\\S]*?${MARK_END}`);
    const updated = existing.replace(re, `${MARK_START}\n${lines.join('\n')}\n${MARK_END}`);
    fs.writeFileSync(target, updated);
    return { target, action: 'updated' };
  }

  const block = `\n${MARK_START}\n${lines.join('\n')}\n${MARK_END}\n`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.appendFileSync(target, block);
  return { target, action: 'appended' };
}

export function apiKeyStatus() {
  return {
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    openai: !!process.env.OPENAI_API_KEY
  };
}

export function portFree(port) {
  return new Promise((resolve) => {
    import('node:net').then(({ default: net }) => {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.once('listening', () => s.close(() => resolve(true)));
      s.listen(port, '127.0.0.1');
    });
  });
}
