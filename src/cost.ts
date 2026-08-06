/** Pricing math for the advisor. Flat per-token pricing, no cache (Pokee-Isaac). */

import type { SliceSettings } from "./config.ts";

export function turnCostUsd(residentTokens: number, expectedOutputTokens: number, s: SliceSettings): number {
	return (residentTokens * s.priceInPerM + expectedOutputTokens * s.priceOutPerM) / 1_000_000;
}

export function fmtUsd(x: number): string {
	return x >= 0.1 ? `$${x.toFixed(2)}` : `$${x.toFixed(3)}`;
}

export function fmtTokens(t: number): string {
	if (t >= 1_000_000) return `${(t / 1_000_000).toFixed(2)}M`;
	if (t >= 1_000) return `${Math.round(t / 1_000)}k`;
	return String(t);
}
