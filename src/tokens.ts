/**
 * Token accounting: dual real/raw engine.
 *
 * Real usage comes from provider-reported Usage on the last assistant
 * message; chars/4 estimation covers trailing messages. Raw estimates drift
 * 20-46% from provider accounting (measured by pi-observational-memory, MIT,
 * https://github.com/elpapi42/pi-observational-memory — its
 * realTokensSinceAnchor design). The chars/4 heuristic matches Pi core's
 * estimateTokens.
 */

import type { AgentMessage, ContentBlock, Usage } from "./pi-types.ts";

export const CHARS_PER_TOKEN = 4;
const IMAGE_CHARS = 4800; // Pi core's convention for non-text blocks

export function estimateText(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function messageChars(m: AgentMessage): number {
	if (typeof m.content === "string") return m.content.length;
	if (!Array.isArray(m.content)) return 0;
	let chars = 0;
	for (const block of m.content) {
		if (block.type === "text") chars += (block as { text: string }).text.length;
		else if (block.type === "toolCall") chars += JSON.stringify(block as ContentBlock).length;
		else chars += IMAGE_CHARS;
	}
	// toolCall blocks on assistant messages may live outside content in some
	// shapes; count stringified extras conservatively via toolCalls field.
	const toolCalls = (m as { toolCalls?: unknown[] }).toolCalls;
	if (Array.isArray(toolCalls)) chars += JSON.stringify(toolCalls).length;
	return chars;
}

/**
 * Historical messages are immutable between context events, so sizes are
 * memoized per message object — the pipeline would otherwise re-stringify
 * every toolCall argument on every LLM call.
 */
const sizeCache = new WeakMap<object, number>();

export function estimateMessage(m: AgentMessage): number {
	const cached = sizeCache.get(m);
	if (cached !== undefined) return cached;
	const size = Math.ceil(messageChars(m) / CHARS_PER_TOKEN);
	sizeCache.set(m, size);
	return size;
}

export function usageContextTokens(u: Usage): number | undefined {
	if (typeof u.totalTokens === "number") return u.totalTokens;
	const input = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
	if (input > 0 || typeof u.output === "number") return input + (u.output ?? 0);
	return undefined;
}

/**
 * Resident context tokens for a message array: provider-reported usage at the
 * last assistant message that has one, plus estimates for everything after.
 * (With no usage anchor, the loop below starts at 0 and estimates everything.)
 */
export function residentTokens(messages: AgentMessage[]): number {
	let anchorIdx = -1;
	let anchorTokens = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role === "assistant" && m.usage) {
			const t = usageContextTokens(m.usage);
			if (t !== undefined) {
				anchorIdx = i;
				anchorTokens = t;
				break;
			}
		}
	}
	let total = anchorTokens;
	for (let i = anchorIdx + 1; i < messages.length; i++) total += estimateMessage(messages[i]!);
	return total;
}
