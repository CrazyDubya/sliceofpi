# NOTICE — Attribution

sliceofpi (MIT) stands on the shoulders of the Pi extension ecosystem. The
mechanisms below were derived from — and in places adapted from — the
following open-source projects. Files containing adapted code carry a header
comment naming their sources. Thank you to every author listed.

## Pi itself

- **Pi coding agent** — earendil-works/pi (formerly badlogic/pi-mono), by
  Mario Zechner and contributors. MIT.
  https://github.com/earendil-works/pi
  sliceofpi is an extension for Pi and follows the event/typing conventions of
  its documented extension API (docs/extensions.md, docs/compaction.md,
  docs/session-format.md).

## Extensions mechanisms were derived from

- **pi-condense** — MIT — https://github.com/jjuraszek/pi-condense
  Tool-output stubbing that preserves toolCall/toolResult pairing
  (src/pruner.ts), the ref indexer with content-hash dedup (src/indexer.ts),
  eager sidecar spill (src/spill.ts), recovery grace windows, and the
  session-custom-entry persistence pattern. → sliceofpi src/pipeline.ts,
  src/state.ts, src/spill.ts.

- **pi-observational-memory** — MIT —
  https://github.com/elpapi42/pi-observational-memory
  The calibrated-absolute threshold philosophy for models that advertise large
  windows but degrade at range, and the dual real/raw token accounting
  (provider usage anchor + chars/4 trailing estimates, with its measurement
  that raw estimates drift 20–46%). → sliceofpi src/config.ts, src/tokens.ts.

- **pi-blackhole** — MIT — https://github.com/k0valik/pi-blackhole
  The deterministic (zero-LLM) structural compaction summary (compile()) and
  the unified recall design with BM25 free-text search over session entries.
  → sliceofpi src/compaction.ts, src/search.ts. (pi-blackhole itself builds on
  pi-observational-memory and pi-vcc.)

- **pi-mega-compact** — BSD-3-Clause —
  https://github.com/TheArchitectit/pi-mega-compact
  Boundary invariants (anchor floor, tool-pair atomicity; src/boundary.ts),
  the return-a-view-from-the-context-event control shape (never abort the
  in-flight turn), and the context-health scoring dimensions (repetition,
  error escalation, drift; src/contextHealth/). → sliceofpi src/pipeline.ts,
  src/health.ts.

  BSD-3-Clause notice reproduction, as required:

  > Copyright (c) pi-mega-compact contributors. All rights reserved.
  > Redistribution and use in source and binary forms, with or without
  > modification, are permitted provided that the conditions of the
  > BSD 3-Clause License are met. THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT
  > HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES
  > ARE DISCLAIMED. See the full license in that repository's LICENSE file.

- **pi-context-tools** — MIT — https://github.com/theduke/pi-context-tools
  The agent self-service pattern: context_info and a deferred
  compact-at-turn-boundary flag. → sliceofpi src/index.ts (context_info,
  request_compact), src/advisor.ts.

- **pi-async-compaction** — MIT —
  https://github.com/almogdepaz/pi-async-compaction
  The background-precompute lifecycle design (pending/ready/stale snapshot
  validation, apply-at-idle) that shapes sliceofpi's roadmap seam for
  subagent/async summarization (DESIGN.md, L3).

## Design references (ideas, no code)

- **oh-my-pi** — MIT — https://github.com/can1357/oh-my-pi — the
  six-trigger compaction taxonomy (docs/compaction.md).
- **Pi core compaction** — the structured summary section layout and the
  <read-files>/<modified-files> cumulative file-tracking convention.
