# toklite

A local CLI that sits between any AI coding tool — Claude Code, Kiro, Cursor, Aider, your own agent — and the model provider, and cuts the tokens that actually leave your machine.

Zero dependencies. Zero code changes in the tool you're wrapping. Your API key never touches disk; it is forwarded from the client to the provider untouched.

```bash
npm install -g toklite

toklite run -- claude          # launch any CLI through the proxy
toklite stats                  # what you saved
toklite fidelity               # did reduction change the answers?
```

Requires Node 20+. Nothing else — no Python, no model download, no account.

If the `toklite` command isn't found after installing, npm's global bin directory isn't on your PATH. The installer detects this and tells you; to fix it:

```bash
toklite setup --write     # adds one marked line to your shell profile
source ~/.zshrc
```

`toklite setup` on its own changes nothing — it prints what it found (shell, profile path, npm global bin, PATH status, port availability, whether an API key is visible) and what to do about it. `toklite doctor` repeats the environment check and then self-tests the reduction pipeline.

### A note on Claude Code and subscription logins

Claude Code signed in with a claude.ai subscription **cannot authenticate through any proxy**. Anthropic rejects OAuth tokens whenever `ANTHROPIC_BASE_URL` points anywhere other than `api.anthropic.com`, and the failure reads as `401 OAuth access token has been revoked` — which looks like a broken login but is a configuration rule. If you hit it, `unset ANTHROPIC_BASE_URL` and restart.

To use toklite with Claude Code, authenticate with an API key instead:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
toklite run -- claude
```

Worth being clear about the economics: subscription usage isn't billed per token, so there is nothing for toklite to save there. **toklite pays off on metered API-key traffic** — Kiro, Cursor and Copilot with your own key, SDK applications, CI pipelines, and custom agents. That is where a 30–50% cut in input tokens is money.

### Connecting a tool

Preferred, because it changes nothing permanent:

```bash
toklite run -- claude
```

That starts the proxy, points the child process at it, and cleans up on exit. For tools that won't inherit environment variables, export them for the session:

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:8787"
export OPENAI_BASE_URL="http://127.0.0.1:8787/v1"
```

Don't put those two lines in your shell profile permanently. They route every tool through a proxy that may not be running, and calls fail when it isn't. `toklite setup --write` deliberately writes only the PATH line for this reason.

Your API key is never read or stored — it's forwarded from client to provider untouched. The one exception is `toklite verify`, which reads `ANTHROPIC_API_KEY` to call the free counting endpoint.

## How it connects

`toklite run` starts a local proxy, sets `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` in the child process, and launches your tool. Nothing else changes.

If your tool doesn't inherit env vars, run the proxy standalone:

```bash
toklite start
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
export OPENAI_BASE_URL=http://127.0.0.1:8787/v1
```

Both `/v1/messages` (Anthropic) and `/v1/chat/completions` (OpenAI) are handled. Anything else is passed straight through.

## What it actually does

Six independent layers. Each one is toggleable, and none of them can ever make a payload larger — every reducer measures its own delta and backs out if it comes up negative.

| Layer | What it removes | Typical saving |
|---|---|---|
| **hygiene** | Trailing whitespace, runaway blank lines, ASCII separator bars | 1–3% |
| **dedupe** | Content re-sent verbatim later in the same conversation — the same file read six times, the same schema, the same log | 20–50% in agent loops |
| **compact** | Long blocks in turns older than the recency window, trimmed to head + tail with an explicit elision marker | 10–30% on long sessions |
| **tools** | Prose descriptions on tool schemas the conversation has never referenced. Names and parameter shapes are never touched | 5–15% when many tools are loaded |
| **cachePoints** | Nothing — it *marks* the stable prefix (tools + system) with `cache_control` so Anthropic bills it at cache rates | up to 90% off the prefix |
| **terse** | Off by default. Appends an instruction to suppress preamble. Output tokens cost 3–5× input | 10–30% of output |

Plus a disk-backed **response cache**: identical requests below a temperature threshold never reach the provider at all. Cached responses are replayed as SSE for streaming clients, so agent CLIs benefit too.

**dedupe is the one that carries the load.** It uses content-defined chunking — chunk boundaries are picked from the content of each line rather than its position — so a file re-read still matches even when it's preceded by a different amount of surrounding prose. Fixed-window shingling misses that case entirely, which is exactly the case agents produce all day.

## Proving it saves

Four checks, in increasing order of independence. The last one needs no trust in this tool at all.

**1. `toklite stats`** — provider-verified totals for everything that has run through the proxy.

**2. `toklite verify` — a free, deterministic proof.** Capture real requests, then count each one twice against the provider's own counting endpoint. No inference runs, so nothing toklite does at request time can influence the result, and it costs nothing to execute:

```bash
toklite config set capture.enabled true
toklite run -- claude        # do a normal session
toklite verify
```

```
Verifying 47 captured request(s) against https://api.anthropic.com
  Counting each one twice with the provider's free count_tokens endpoint.
  No inference is run. This costs nothing.

  1,284,551 -> 703,918 input tokens across 47 request(s)
  saved 580,633 tokens (-45.2%)
  worth $1.74 at 2026-07-18 input rates, on this sample alone
```

Deterministic and repeatable: same captures in, same answer out. Turn `capture.enabled` back off afterwards — the files contain your prompts.

**3. Do the same curl by hand.** Nothing here is privileged. Take any captured request from `~/.toklite/captures/`, POST it to `/v1/messages/count_tokens`, apply the reducers, POST it again, subtract.

**4. Your provider console.** The only fully external check. Run a week with toklite and a week without on comparable work, and compare billed input tokens in the dashboard. Slower and noisier than the others, but it answers to nobody's code.

## Verify it isn't breaking anything

```bash
toklite doctor                 # self-test the pipeline on a synthetic agent payload
toklite run --shadow -- kiro   # measure only: originals go upstream, savings are reported
```

Shadow mode is the honest default for evaluating this. Run a real day of work through it, read `toklite stats`, and only then turn it on for real.

## Real numbers, or none

toklite does not estimate tokens. There is no bundled heuristic tokenizer, because every available one is wrong for Claude — tiktoken undercounts Claude by 15–20% on prose and considerably more on code, and recent Claude models changed tokenizer again. A number that is 20% wrong is worse than no number.

Both sides of the comparison come from the provider:

| | Source | Cost |
|---|---|---|
| **after** — what you were actually billed | the `usage` block on every response (`input + cache_read + cache_creation`) | free, always present |
| **before** — what the unreduced request would have cost | `POST /v1/messages/count_tokens` with the original body | free, rate-limited only |
| **before**, OpenAI | the fidelity replay's `prompt_tokens`, or local `js-tiktoken` if installed | sampled / optional |

The count runs *after* your response has been delivered, so exact accounting adds zero latency. Requests that cannot be measured are reported as **unmeasured** and excluded from the totals — never backfilled with a guess.

```
toklite stats

  requests        2   (cache hits: 1)

  exact — counted by the provider, not estimated
    input without toklite   1,816 tokens
    input actually billed     762 tokens
    saved                   1,054 tokens  (-58.0%)
    output billed             120 tokens

  money
    would have cost         $0.007248
    actually cost           $0.004086
    saved                   $0.003162

  measured 2/2 requests (100%)
```

Cost is computed from real billing categories, including the cache tiers — reads at 10% of input, writes at 125% — so `cachePoints` is credited with what it actually saved rather than what it theoretically should. Rates are dated and overridable:

```bash
toklite pricing
toklite config set pricing.claude-sonnet-5.in 2
```

Reducers report **characters removed**, which is measured locally and exactly. That is what the per-layer breakdown shows, with each layer's share of the verified token saving apportioned by the bytes it removed.

Per-response headers:

```
x-toklite-bytes-removed: 559
x-toklite-cache:         miss
x-toklite-mode:          active
```

## The fidelity gate

Reduction is only worth anything if the answers stay the same. toklite measures that instead of asserting it.

On a sampled fraction of requests (1% by default) it replays the **original, unreduced** request upstream in the background — after your answer has already been delivered, so it adds no latency — and scores the two responses against each other.

```
toklite fidelity

  samples         214
  matched         211  98.6%
  near-match      2
  divergent       1    0.5%
  avg similarity  0.981
  avg reduction   -34.2% on audited requests

  Headline: -34% tokens, answers matched 98.6% of the time (n=214).
```

Scoring weights **behaviour over prose**. In an agent loop a differently worded sentence is noise; a different tool call is a behavioural change. So a response with identical text but different tool arguments is scored `divergent`, not `match` — which is exactly the failure a text-similarity checker would wave through.

| Comparison | Verdict |
|---|---|
| Same tools, same arguments | match |
| Reworded prose, similarity ≥ 0.85 | match |
| Same tools, **different arguments** | divergent |
| Different tool called | divergent |

To calibrate deliberately rather than waiting for the 1% sample to accumulate:

```bash
toklite run --audit --verbose -- claude
```

`--audit` replays *every* request. That roughly doubles spend for the duration, so it is capped by `fidelity.dailyBudgetTokens` and the audit's own cost is reported in the summary — the overhead is never hidden inside the savings number.

The gate has already paid for itself once: it caught a chunk-phase misalignment bug in dedupe on periodic content, which is why detection is now anchor-based rather than chunk-based.

## Configuration

```bash
toklite config                                    # show current
toklite config init                               # write defaults to ~/.toklite/config.json
toklite config set reducers.compact.keepRecentTurns 10
toklite config set reducers.terse.enabled true
toklite config set cache.enabled false
toklite config set fidelity.sampleRate 0.05
toklite cache clear
toklite fidelity reset
```

## What this will not do

Honest limits, because the category is full of inflated claims:

- **Novel one-shot prompts barely move.** There is nothing repeated to remove. Savings come from repetition, and agent loops are almost entirely repetition — that's why this pays off there and not in chat.
- **compact is lossy by construction.** It elides the middle of old blocks. The marker tells the model something was removed so it can ask again, but if your workflow depends on verbatim recall of turn 3, raise `keepRecentTurns` or disable it.
- **Exact counting needs a cooperating provider.** Anthropic gives a free counting endpoint, so coverage is complete there. OpenAI has none, so `before` comes from sampled fidelity replays unless you `npm i js-tiktoken`. Local proxies and gateways that don't return `usage` will show up as unmeasured.
- **Prices go stale.** The built-in table is dated and overridable. Check `toklite pricing` against your invoice before quoting the dollar figure to anyone.
- **The cache is exact-match**, not semantic. Semantic matching needs an embedding model, which means a heavier install and a real false-positive risk. Deliberately out of scope for v0.

## Where to take it next

- Semantic cache behind an opt-in flag, with a similarity floor and a divergence sampler
- Per-project profiles, since a Terraform repo and a React repo have very different repetition profiles

MIT.