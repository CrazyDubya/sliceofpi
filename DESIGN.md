# sliceofpi — Design (Step 4)

Context management for the Pi coding agent on a 10M-token-context model
(Pokee-Isaac 28B). The window is huge; cost and attention are not. Every turn
re-sends the entire resident context at $0.15/M input with **no prompt
caching**, so the true cost driver is `turns × resident tokens`, and long-tail
conversations silently make simple tasks expensive. sliceofpi keeps the
steady-state working set small, advises the user in tiers, and treats the 10M
window as headroom for deliberate big-context tasks — never as a default.

## Constraints (from Steps 1–3 research)

- Model: Pokee-Isaac 28B via OpenAI-compatible API (`https://api.pokee.ai/v1`).
  10M context, 60k max output budget, flat $0.15/M in / $1.00/M out, **no
  prompt caching**, requests >16MiB require SSE streaming, text-only.
- Effective attention at long range is unproven (self-reported RULER numbers
  only); design assumes degradation and keeps the working set in the low
  hundreds of thousands of tokens unless the user opts into more.
- Harness: Pi (`@earendil-works/pi-coding-agent`) extension API. No fork of Pi.
  `session_before_compact` is effectively single-owner among extensions: this
  extension owns it exclusively and no other compaction extension may be
  installed alongside.

## Architecture — five layers

### L1 — Live per-call trim (`context` hook)
Every outbound LLM call passes through a pipeline of **pure
`messages → messages` transforms**. Pi keeps the full transcript; the model
sees a trimmed view. Never aborts an in-flight turn (lesson from
pi-mega-compact: calling `ctx.compact()` from the auto path aborts the turn;
returning a trimmed view does not).

Pipeline stages (ordered):
1. `stubStage` — replace tool results already summarized/indexed with short
   stubs carrying a recall ref (`t<N>`). Preserves message alternation and
   never orphans a toolCall (from pi-condense's pruner).
2. `purgeStage` — after a cooldown, drop the argument bodies of *failed* tool
   calls (keep the error result). (pi-condense error-purge.)
3. `boundaryStage` — invariants, applied last: never split a
   toolCall/toolResult pair; always keep the last `anchorUserMessages` user
   turns untouched. (pi-mega-compact boundary rules.)
4. `capStage` — if the view still exceeds `liveTrimCap`, drop oldest closed
   turns from the view (view only — durable truncation is L3's job).

The pipeline is the designed seam for the future roadmap item *direct outbound
prompt manipulation*: new manipulations are additional stages.

### L2 — Tool-output stubbing, spill, and recall
- **Indexer**: every tool result gets a short ref `t<N>`, content-hash deduped
  (identical outputs share one record). Rebuilt from session entries on
  `session_start` — restart-safe. (pi-condense indexer.)
- **Spill**: oversized results (> `spillThresholdChars`) are written eagerly to
  sidecar files `<sessionDir>/<sessionId>-blobs/` with a head preview kept
  inline. Zero LLM cost. (pi-condense spill.)
- **Recovery grace**: a recalled output is not re-stubbed for
  `recoveryGraceTurns` user turns. (pi-condense.)
- **`recall` tool** (single agent-facing tool): accepts `t<N>` refs, or
  free-text query answered by BM25 over the session JSONL entries.
  (unified-recall design from pi-blackhole; BM25 from its search-entries.)

### L3 — Compaction (durable) — deterministic first
This extension owns `session_before_compact` and always answers it.

- **Deterministic render** (default, zero LLM calls — every summarizer call is
  un-cached full price): structured summary compiled from the session itself —
  goal (first user message), files read/modified (cumulative, inherited across
  compactions per Pi's convention), commits/commands observed, open items from
  the most recent turns, plus the kept tail. (pi-blackhole `compile()` design.)
- **Optional LLM polish**: settings may name a `summarizerModel`; when set, the
  deterministic render is upgraded by one bounded LLM pass in the background
  (L3 lifecycle below), never synchronously at compact time.
- **Async precompute lifecycle**: `idle → pending → ready | stale | failed`
  state machine with snapshot validation (session id, model, settings, leaf
  entry) and apply-at-idle; a ready result is handed to
  `session_before_compact` when it fires. (pi-async-compaction lifecycle +
  adapter seam, which is also the reserved seam for future *subagent*
  management.)
- Tail policy: `keepRecentTokens` absolute (default 30k) — aggressive by
  default because retained tail is re-billed every turn.

### L4 — Thresholds & tiers (all absolute tokens)
Percent-of-window logic is explicitly rejected: every surveyed extension's
ratio defaults fire at 7–8M on a 10M window, far past both economic sense and
plausible attention. (pi-observational-memory's "calibrated" absolute mode,
generalized.)

Token accounting is dual-source: **real** provider-reported usage from the
last assistant message when available, plus chars/4 estimation for trailing
messages (raw estimates drift 20–46% from provider accounting — measured by
pi-observational-memory). Incremental size accounting; never
`JSON.stringify(allMessages)` per call at multi-M scale.

Default `pokee-isaac-10m` profile:

| Tier | Trigger (resident tokens) | Behavior |
|------|--------------------------|----------|
| T0 quiet     | < 100k  | footer stats only |
| T1 notice    | ≥ 100k  | footer highlights; per-turn cost shown |
| T2 advise    | ≥ 250k  | advisory message: what the tail costs per turn, what recall would preserve; suggests `/slice compact` |
| T3 act       | ≥ 400k  | auto-compact at next turn boundary (unless big-task mode) |
| T4 headroom  | ≥ 1M    | big-task mode only; every turn shows $/turn and asks intent on task switch |

**Big-task mode** (`/slice big [budget]`): user opts into a large working set
for a genuinely big task (e.g. "read this 3M-token corpus"). Suspends T3
auto-compaction up to the stated budget, keeps warnings on, and recommends
returning to normal (compact) when the task completes.

**Health-adaptive modifier** (the one novel mechanism): a cheap per-turn score
from output repetition, error escalation, and topic drift lowers the T3
trigger when the model shows degradation. No cache-poison scoring (no cache).

**Task sizing** (advisor): before a turn starts (`before_agent_start`), an
algorithmic estimate of the *incoming* work (prompt size, referenced files'
sizes, big-task mode) is compared with resident context; when a small task
arrives on a fat tail (est. task tokens ≪ resident tokens), the advisor says
so and quotes the savings of compacting first. LLM-assisted sizing is a
designed extension point, deliberately not in v1's hot path.

### L5 — Advice, UI, agent self-service
- Footer widget: `resident tokens | tier | $/turn | $ session`.
- `/slice` command: `status`, `compact [instructions]`, `big [budget]`,
  `normal`, `auto on|off`.
- Agent-facing tools: `context_info` (usage + tier + costs) and
  `request_compact` (flag honored at the next turn boundary — the
  pi-context-tools pattern).
- Every advisory is a visible message, not a hidden mutation: the user always
  sees why cost is what it is.

## State
Primary store: Pi session custom entries (`sliceofpi:*`) — restart-safe,
branch-aware, no external DB (pi-condense / pi-observational-memory pattern).
Sidecar blob dir for spilled outputs. Nothing else in v1.

## Attribution & licensing (for publication)
- This project: MIT.
- `NOTICE.md` lists every upstream project mechanisms were derived from, with
  repo URL, license, and what was taken (idea vs adapted code). Files with
  adapted code carry a header comment naming the source file and license:
  pi-condense (MIT), pi-async-compaction (MIT), pi-observational-memory (MIT),
  pi-blackhole (MIT), pi-mega-compact (BSD-3-Clause), pi-context-tools (MIT).
  BSD-3 requires the copyright notice + disclaimer reproduction — satisfied in
  NOTICE.md.
- README credits section mirrors NOTICE.md.

## Benchmarking (Step 5 deliverable)
Offline, deterministic, no API key needed (plus an optional live mode later):

1. **Workload generator**: synthetic coding-session transcripts with
   controlled shape — tool-result size distribution (many small + heavy-tailed
   big reads), N user turns, task boundaries, an injected set of "facts"
   planted in early tool outputs.
2. **Strategies compared** on identical transcripts:
   - `none` — no management (what stock Pi does at 10M: threshold never fires)
   - `native` — simulated stock Pi compaction at a fixed threshold
     (summarize-older/keep-recent, modeled cost for the summarizer call)
   - `sliceofpi` — the real L1/L2/L4 pipeline (the actual shipped code, not a
     model of it)
3. **Metrics**:
   - cumulative billed input tokens and $ (Pokee pricing), peak resident
     context, tokens/turn curve
   - **retention**: fraction of planted facts still reachable — inline, via
     recall ref, or via BM25 query (measures that aggressive trimming keeps
     information *recoverable*, the failure mode of naive truncation)
   - invariant checks: role alternation intact, no orphaned toolCalls
4. Output: table + JSON; committed as `bench/results/`.

What the benchmark cannot show (stated honestly in the README): model-quality
effects of trimming require live A/B with real tasks; the offline bench
measures cost, retention, and correctness only.

## v1 non-goals (designed seams, not built)
- Subagent management (seam: adapter interface + per-child pending state)
- Historical-conversation recall (seam: recall `scope` param over an index of
  past session files)
- LLM-assisted task sizing (seam: advisor interface)
- Live model-quality A/B benchmark (needs API key + spend)
