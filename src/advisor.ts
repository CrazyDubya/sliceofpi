/**
 * L4/L5 — tier evaluation and user-facing advice. Every advisory is a
 * visible message; the user always sees why cost is what it is.
 *
 * The "deferred compact at turn boundary" flag pattern is from
 * pi-context-tools (MIT, https://github.com/theduke/pi-context-tools).
 */

import { resolveTier, type SliceSettings, type Tier } from "./config.ts";
import { fmtTokens, fmtUsd, turnCostUsd } from "./cost.ts";
import { CHARS_PER_TOKEN, estimateText } from "./tokens.ts";

export interface Advice {
	tier: Tier;
	footer: string;
	/** message to surface to the user this turn, if any */
	notice?: string;
	/** auto-compact should fire at the next turn boundary */
	shouldCompact: boolean;
}

export interface AdvisorInput {
	residentTokens: number;
	taskEstimateTokens: number;
	sessionSpendUsd: number;
	health: number; // [0,1], 1 = healthy
	bigTaskBudget: number | undefined;
	compactRequested: boolean;
	settings: SliceSettings;
}

export function advise(input: AdvisorInput): Advice {
	const { residentTokens: resident, settings: s } = input;
	const tier = resolveTier(resident, s, input.health);
	const perTurn = turnCostUsd(resident, 4_000, s);
	const footer = `${fmtTokens(resident)} ctx | ${tier} | ${fmtUsd(perTurn)}/turn | ${fmtUsd(input.sessionSpendUsd)} spent`;

	const big = input.bigTaskBudget !== undefined && resident < input.bigTaskBudget;
	let notice: string | undefined;
	let shouldCompact = input.compactRequested;

	// small task on a fat tail: the tail, not the task, is what you'd pay for
	const smallTaskFatTail =
		tier !== "quiet" &&
		tier !== "notice" &&
		input.taskEstimateTokens > 0 &&
		input.taskEstimateTokens * 10 < resident;

	// Pokee gateway realities (docs): ~4 chars/token means the 16MiB SSE
	// boundary lands near 4M tokens and the 45MiB hard reject near 11M; the
	// account-wide 20M tokens/min limit makes multi-M contexts turn-rate-limited.
	let gatewayNote = "";
	if (resident >= 9_000_000)
		gatewayNote = ` WARNING: approaching the 45MiB request cap — the gateway will reject soon; compact now.`;
	else if (resident >= 4_000_000)
		gatewayNote = ` Note: requests this size stream via SSE, prefill can take minutes, and >2 turns/min will hit the 20M tokens/min limit.`;

	if (tier === "headroom" && !big) {
		notice =
			`Context is ${fmtTokens(resident)} — headroom territory (${fmtUsd(perTurn)}/turn). ` +
			`If this is intentional, run /slice big <budget>; otherwise /slice compact.` +
			gatewayNote;
		shouldCompact = shouldCompact || s.autoCompact;
	} else if (big && gatewayNote) {
		notice = `Big-task mode at ${fmtTokens(resident)}.${gatewayNote}`;
		// the 45MiB reject is a hard cliff: compact even in big-task mode
		shouldCompact = shouldCompact || resident >= 9_000_000;
	} else if (tier === "act" && !big) {
		notice = `Context ${fmtTokens(resident)} ≥ act threshold — compacting at next turn boundary (auto). /slice auto off to disable.`;
		shouldCompact = shouldCompact || s.autoCompact;
	} else if (tier === "advise") {
		const savings = turnCostUsd(resident - s.keepRecentTokens, 0, s);
		notice =
			`Context is ${fmtTokens(resident)}; every message now costs ~${fmtUsd(perTurn)} before output. ` +
			`Compacting would save ~${fmtUsd(savings)}/turn; stubbed output stays recoverable via recall. /slice compact when ready.`;
	}

	if (smallTaskFatTail) {
		const taskShare = turnCostUsd(input.taskEstimateTokens, 0, input.settings);
		notice =
			(notice ? `${notice}\n` : "") +
			`This task looks small (~${fmtTokens(input.taskEstimateTokens)} tokens, ${fmtUsd(taskShare)}); ` +
			`the other ${fmtUsd(perTurn)} per turn is conversation tail.`;
	}

	return { tier, footer, notice, shouldCompact };
}

/** Algorithmic incoming-task size estimate: prompt + likely file references. */
export function estimateTaskTokens(prompt: string, referencedFileSizes: number[]): number {
	return referencedFileSizes.reduce((a, b) => a + Math.ceil(b / CHARS_PER_TOKEN), estimateText(prompt));
}
