/**
 * High-leverage reducers that operate on the buckets `toklite profile` shows
 * dominate a real agent bill: images (largest input bucket for any screenshot
 * agent) and output tokens (billed at 3-5x input).
 *
 * These are separated from the core text reducers because two of them have
 * heavier machinery: image downscaling needs an optional native dependency,
 * and diff re-reads need per-conversation state.
 */
import crypto from 'node:crypto';

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

/* ------------------------------------------------------------------ *
 * IMAGES — Anthropic bills an image at roughly (width x height) / 750
 * tokens. A 1568x1568 screenshot is ~3278 tokens; downscaling the long
 * edge to 1024 is a ~57% cut on what is usually the single largest
 * bucket. Requires `sharp`; if absent, the reducer reports why and does
 * nothing rather than guessing.
 * ------------------------------------------------------------------ */
let sharp = null;
let sharpTried = false;

async function loadSharp() {
  if (sharpTried) return sharp;
  sharpTried = true;
  try { sharp = (await import('sharp')).default; } catch { sharp = null; }
  return sharp;
}

function collectImages(body) {
  const imgs = [];
  for (const msg of body.messages || []) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block?.type === 'image' && block.source?.type === 'base64' && block.source.data) {
        imgs.push({ get: () => block.source.data, set: (v) => { block.source.data = v; },
                    media: () => block.source.media_type,
                    setMedia: (m) => { block.source.media_type = m; } });
      }
    }
  }
  return imgs;
}

// token cost of an image, from its pixel dimensions
const imgTokens = (w, h) => Math.ceil((w * h) / 750);

export async function images(body, format, opt) {
  if (format !== 'anthropic') return { name: 'images', chars: 0, note: 'n/a' };
  const list = collectImages(body);
  if (!list.length) return { name: 'images', chars: 0 };

  const lib = await loadSharp();
  if (!lib) return { name: 'images', chars: 0, note: 'sharp not installed — `npm i sharp` to enable image downscaling' };

  const maxEdge = opt.maxEdge || 1024;
  let tokensSaved = 0, bytesSaved = 0, done = 0;

  for (const img of list) {
    try {
      const raw = Buffer.from(img.get(), 'base64');
      const pipeline = lib(raw);
      const meta = await pipeline.metadata();
      if (!meta.width || !meta.height) continue;
      const longEdge = Math.max(meta.width, meta.height);
      if (longEdge <= maxEdge) continue;                 // already small enough

      const scale = maxEdge / longEdge;
      const nw = Math.round(meta.width * scale);
      const nh = Math.round(meta.height * scale);

      const out = await lib(raw)
        .resize(nw, nh, { fit: 'inside' })
        .png({ compressionLevel: 9 })
        .toBuffer();

      tokensSaved += imgTokens(meta.width, meta.height) - imgTokens(nw, nh);
      const newB64 = out.toString('base64');
      bytesSaved += img.get().length - newB64.length;
      img.set(newB64);
      img.setMedia('image/png');
      done++;
    } catch { /* leave this image untouched on any failure */ }
  }
  return { name: 'images', chars: bytesSaved, tokensSaved, imagesResized: done };
}

/* ------------------------------------------------------------------ *
 * OUTPUT CAP — output tokens bill at 3-5x input. Agents routinely send
 * max_tokens far above what a turn needs (8192, 16384) "just in case",
 * and providers bill only what is generated, so a cap does not by itself
 * save money -- but it bounds worst-case cost and, combined with a terse
 * instruction, measurably shortens responses. This only lowers an
 * explicit ceiling; it never raises one, and never touches a request
 * that set a deliberate low value.
 * ------------------------------------------------------------------ */
export function outputCap(body, format, opt) {
  const ceil = opt.maxTokens || 4096;
  const key = format === 'openai' ? 'max_completion_tokens' : 'max_tokens';
  const cur = body[key] ?? body.max_tokens;
  if (typeof cur !== 'number') return { name: 'outputCap', chars: 0 };
  if (cur <= ceil) return { name: 'outputCap', chars: 0 };
  body[key] = ceil;
  return { name: 'outputCap', chars: 0, ceiling: `${cur}->${ceil}` };
}

/* ------------------------------------------------------------------ *
 * DIFF RE-READS — the lever profile points at for tool_results.
 *
 * Core dedupe only catches IDENTICAL regions, so editing one line of a
 * file makes the entire re-read look novel. Here, tool_result blocks that
 * are near-copies of an earlier one are re-expressed as a unified diff
 * against that earlier copy: "identical to message #k except these lines".
 *
 * Exact and reversible -- the model can reconstruct the new content from
 * the old content plus the hunks -- and it composes with dedupe rather
 * than competing (dedupe handles the unchanged 100% case, this handles
 * the changed-a-little case).
 * ------------------------------------------------------------------ */
function toolResultTexts(body) {
  const out = [];
  (body.messages || []).forEach((msg, turn) => {
    if (!Array.isArray(msg.content)) return;
    for (const block of msg.content) {
      if (block?.type === 'tool_result') {
        if (typeof block.content === 'string') {
          out.push({ turn, get: () => block.content, set: (v) => { block.content = v; } });
        } else if (Array.isArray(block.content)) {
          block.content.forEach((inner, i) => {
            if (inner?.type === 'text' && typeof inner.text === 'string') {
              out.push({ turn, get: () => block.content[i].text, set: (v) => { block.content[i].text = v; } });
            }
          });
        }
      }
    }
  });
  return out;
}

// Minimal line-level diff (LCS). Small inputs, so O(n*m) is fine.
function lineDiff(aLines, bLines) {
  const n = aLines.length, m = bLines.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = aLines[i] === bLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const hunks = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) { i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { hunks.push('-' + aLines[i]); i++; }
    else { hunks.push('+' + bLines[j]); j++; }
  }
  while (i < n) hunks.push('-' + aLines[i++]);
  while (j < m) hunks.push('+' + bLines[j++]);
  return hunks;
}

export function diffReads(body, format, opt) {
  if (format !== 'anthropic') return { name: 'diffReads', chars: 0, note: 'n/a' };
  const blocks = toolResultTexts(body);
  if (blocks.length < 2) return { name: 'diffReads', chars: 0 };

  const min = opt.minChars || 400;
  const seen = [];                 // { text, lines, turn }
  let saved = 0;

  for (const b of blocks) {
    const text = b.get();
    if (typeof text !== 'string' || text.length < min) continue;
    if (text.startsWith('[toklite')) continue;      // already elided by dedupe

    const lines = text.split('\n');
    let best = null, bestRatio = 0;
    for (const prev of seen) {
      // cheap similarity screen: shared line fraction
      const prevSet = new Set(prev.lines);
      let shared = 0;
      for (const l of lines) if (prevSet.has(l)) shared++;
      const ratio = shared / Math.max(lines.length, prev.lines.length);
      if (ratio > bestRatio) { bestRatio = ratio; best = prev; }
    }

    // Only worth diffing if very similar but not identical.
    if (best && bestRatio >= (opt.minSimilarity || 0.5) && bestRatio < 1) {
      const hunks = lineDiff(best.lines, lines);
      const patch = `[toklite: identical to the tool result in message #${best.turn}, with these line changes applied:]\n` +
                    hunks.join('\n');
      if (patch.length < text.length) {
        saved += text.length - patch.length;
        b.set(patch);
      }
    }
    seen.push({ text, lines, turn: b.turn });
  }
  return { name: 'diffReads', chars: saved };
}
