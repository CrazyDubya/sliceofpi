# sliceofpi

Context management for the [Pi coding agent](https://github.com/earendil-works/pi)
on 10M-token-context models — built for
[Pokee-Isaac 28B](https://console.pokee.ai/model), where the window is huge
but every turn re-sends the entire context at flat per-token pricing with no
prompt caching. **The window is not the constraint; cost and attention are.**

sliceofpi keeps your steady-state working set small, tells you what your
conversation tail costs per message, and treats the 10M window as headroom you
opt into for genuinely big tasks — never as a default you drift into.

## What it does

- **Tiered advice, absolute tokens** — quiet → notice (100k) → advise (250k)
  → act (400k, auto-compact) → headroom (1M+, opt-in big-task mode).
  Percent-of-window triggers are rejected by design: 80% of 10M is 8M, far
  past both economic sense and plausible model attention.
- **Live per-call trimming** — a pure-transform pipeline in Pi's `context`
  event stubs old tool outputs, purges failed-call bodies, and caps the
  outbound view. Pi's transcript stays complete; only what the model sees is
  trimmed. Never aborts an in-flight turn.
- **Nothing is lost** — stubbed outputs carry a `recall("t12")` ref;
  oversized outputs spill to sidecar files; a `recall` tool fetches by ref or
  BM25-searches everything ever indexed.
- **Deterministic compaction** — structured summary (goal, files, commands,
  progress) compiled with **zero LLM calls**, because on an un-cached model
  every summarizer call is full price. This extension solely owns
  `session_before_compact`; don't install another compaction extension
  alongside it.
- **Cost honesty** — footer shows resident tokens, tier, $/turn, and session
  spend. When a small task arrives on a fat tail, it says so:
  *"This task looks small (~2k tokens, $0.0003); the other $0.05 per turn is
  conversation tail."*
- **Health-adaptive thresholds** — repetition/error scoring lowers the
  auto-compact trigger when the model shows long-context degradation.
- **Agent self-service** — `context_info` and `request_compact` tools let the
  agent manage its own context (compaction fires at turn boundaries only).

## Install

```bash
pi install git:github.com/crazydubya/sliceofpi   # or clone into ~/.pi/agent/extensions/
```

Point Pi at Pokee-Isaac via `~/.pi/agent/models.json` (OpenAI-compatible;
requests over 16MiB require SSE streaming):

```json
{
  "providers": {
    "pokee": {
      "baseUrl": "https://api.pokee.ai/v1",
      "api": "openai-completions",
      "apiKey": "POKEE_API_KEY",
      "models": [
        {
          "id": "pokee-isaac-28b",
          "contextWindow": 10000000,
          "maxTokens": 60000,
          "cost": { "input": 0.15, "output": 1.0 }
        }
      ]
    }
  }
}
```

## Use

- `/slice status` — resident tokens, spend, mode, health
- `/slice compact` — compact at next turn boundary
- `/slice big 2m` — big-task mode: suspend auto-compaction up to 2M tokens
- `/slice normal` — back to normal; compact recommended
- `/slice auto on|off` — toggle auto-compaction

Settings live under the `sliceofpi` key of Pi's settings.json; defaults are
the `pokee-isaac-10m` profile (src/config.ts).

## Benchmark

Offline, deterministic, no API key: `npm run bench` replays identical
synthetic coding sessions (heavy-tailed tool outputs, planted facts) through
three strategies at Pokee pricing. Representative run (3 seeds × 60 turns):

| strategy | billed input | $ total | peak ctx | retention | invariants |
|---|---|---|---|---|---|
| none (stock Pi @10M) | 19.98M | $3.04 | 599k | 100% | ok |
| native-style compaction | 13.09M | $2.01 | 427k | 20%* | ok |
| **sliceofpi** | **1.70M** | **$0.30** | **84k** | **77%** | ok |

\* modeled constant (LLM summaries are lossy; generously assumed 20%). `none`
and `sliceofpi` retention are measured: a planted fact counts as retained only
if it is inline in the final view or actually surfaced by a `recall` BM25
query.

### Live A/B (real Pokee-Isaac API, preliminary — k=1 per arm)

`bench/live/run.ts` drives scripted episodes through `pi --mode rpc` in both
arms with programmatic verifiers; raw results in `bench/live/results/`.

- **Parity** (short coding tasks): both arms pass at equal cost (~$0.003) —
  sliceofpi stays out of the way below its thresholds.
- **Fat tail** (13 prompts, ~700k-token tail): both arms pass all probes
  including retrieval of a fact planted 10+ prompts earlier and a bug fix.
  Stock Pi: $0.449 (2.97M input tokens); sliceofpi: **$0.135** (878k) —
  **3.3× cheaper, 2.2× faster**. Stock Pi re-billed ~200k tokens
  (~$0.03/prompt) to answer one-word questions; sliceofpi paid 6–16k.
- **Big tail** (three 4,800-line logs read in full): sliceofpi passed all
  probes at $0.33. Stock Pi spent $0.76 through just 6 of 10 prompts, then
  exhausted the account's remaining API credits (provider 402) before
  reaching the probes — a budget exhaustion, not a measured quality failure,
  on the same account and episode that sliceofpi completed with credit to
  spare.

Preliminary caveats: single repeat per arm, one task family, one model.
Planned: k≥3 repeats, funded completion of the big-tail stock arm, and
degradation-sensitive quality probes.

## Development

```bash
npm install
npm test        # vitest, 27 tests
npm run typecheck
npm run bench
```

Architecture and rationale: [DESIGN.md](DESIGN.md). Roadmap seams (designed,
not built): subagent management, historical-conversation recall, LLM-assisted
task sizing.

## Credits

sliceofpi aggressively combines mechanisms pioneered by the Pi extension
ecosystem — pi-condense, pi-observational-memory, pi-blackhole,
pi-mega-compact, pi-context-tools, pi-async-compaction, and Pi itself by
Mario Zechner. Full attribution with links and licenses: [NOTICE.md](NOTICE.md).

MIT — see [LICENSE](LICENSE).
