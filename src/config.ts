/**
 * Settings and the pokee-isaac-10m profile. All thresholds are ABSOLUTE
 * tokens: percent-of-window logic is rejected by design (DESIGN.md, L4).
 *
 * Threshold-mode design derived from pi-observational-memory (MIT,
 * https://github.com/elpapi42/pi-observational-memory) — its "calibrated"
 * absolute mode for models that advertise large windows but degrade at range.
 */

export interface TierThresholds {
	notice: number; // T1
	advise: number; // T2
	act: number; // T3 auto-compact
	headroom: number; // T4
}

export interface SliceSettings {
	profile: string;
	tiers: TierThresholds;
	/** L1 view cap: trim outbound view to at most this many tokens */
	liveTrimCap: number;
	/** recent user turns never touched by any stage */
	anchorUserMessages: number;
	/** durable compaction keeps this many recent tokens */
	keepRecentTokens: number;
	/** stub tool results older than this many user turns */
	stubAfterTurns: number;
	/** spill tool results larger than this many chars to sidecar files */
	spillThresholdChars: number;
	/** chars of head preview kept inline for spilled/stubbed results */
	stubPreviewChars: number;
	/** recalled refs are immune from re-stubbing for this many user turns */
	recoveryGraceTurns: number;
	/** purge failed toolCall argument bodies after this many user turns */
	errorPurgeAfterTurns: number;
	/** auto-compact at T3 */
	autoCompact: boolean;
	/** pricing, $ per 1M tokens */
	priceInPerM: number;
	priceOutPerM: number;
	/** health-adaptive threshold: lower T3 by up to this fraction when degraded */
	healthMaxTighten: number;
}

export const POKEE_ISAAC_10M: SliceSettings = {
	profile: "pokee-isaac-10m",
	tiers: { notice: 100_000, advise: 250_000, act: 400_000, headroom: 1_000_000 },
	liveTrimCap: 500_000,
	anchorUserMessages: 2,
	keepRecentTokens: 30_000,
	stubAfterTurns: 2,
	spillThresholdChars: 32_000,
	stubPreviewChars: 400,
	recoveryGraceTurns: 3,
	errorPurgeAfterTurns: 2,
	autoCompact: true,
	priceInPerM: 0.15,
	priceOutPerM: 1.0,
	healthMaxTighten: 0.5,
};

export type Tier = "quiet" | "notice" | "advise" | "act" | "headroom";

/** Resolve the tier for a resident-token count; health in [0,1], 1 = healthy. */
export function resolveTier(tokens: number, s: SliceSettings, health = 1): Tier {
	const tighten = 1 - (1 - clamp01(health)) * s.healthMaxTighten;
	if (tokens >= s.tiers.headroom) return "headroom";
	if (tokens >= s.tiers.act * tighten) return "act";
	if (tokens >= s.tiers.advise * tighten) return "advise";
	if (tokens >= s.tiers.notice) return "notice";
	return "quiet";
}

function clamp01(x: number): number {
	return Math.max(0, Math.min(1, x));
}

/** Merge user overrides (from settings.json `sliceofpi` key) onto the profile. */
export function loadSettings(overrides?: Partial<SliceSettings>): SliceSettings {
	return { ...POKEE_ISAAC_10M, ...overrides, tiers: { ...POKEE_ISAAC_10M.tiers, ...overrides?.tiers } };
}
