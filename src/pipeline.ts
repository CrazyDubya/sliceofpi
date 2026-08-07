/**
 * L1 — live per-call trim: a pipeline of pure messages -> messages
 * transforms applied in Pi's `context` event. Pi keeps the full transcript;
 * the model sees the trimmed view. Never aborts an in-flight turn.
 *
 * Derived from:
 * - pi-condense (MIT, https://github.com/jjuraszek/pi-condense): stub
 *   replacement that preserves toolCall/toolResult pairing (src/pruner.ts),
 *   failed-call argument purge (src/error-purge.ts), recovery grace.
 * - pi-mega-compact (BSD-3-Clause,
 *   https://github.com/TheArchitectit/pi-mega-compact): boundary invariants
 *   (src/boundary.ts) — anchor floor of recent user turns, tool-pair
 *   atomicity — and the return-a-view control shape (context-handler).
 */

import type { SliceSettings } from "./config.ts";
import type { AgentMessage, ToolCallBlock } from "./pi-types.ts";
import { estimateMessage } from "./tokens.ts";
import type { SliceState } from "./state.ts";

export interface PipelineInput {
	messages: AgentMessage[];
	state: SliceState;
	settings: SliceSettings;
	/** index of the first message of the anchor window; set by runPipeline */
	anchor: number;
}

export type Stage = (input: PipelineInput) => AgentMessage[];

export function isUserMessage(m: AgentMessage): boolean {
	return m.role === "user" && !m.customType;
}

/** Index of the first message of the Nth-from-last user turn (the anchor). */
export function anchorIndex(messages: AgentMessage[], anchorUserMessages: number): number {
	let seen = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (isUserMessage(messages[i]!)) {
			seen++;
			if (seen >= anchorUserMessages) return i;
		}
	}
	return 0;
}

export function makeStub(ref: string, toolName: string, chars: number, preview: string, spilled: boolean): string {
	const where = spilled ? "spilled to disk" : "indexed";
	return (
		`[sliceofpi: ${toolName} output (${chars} chars) ${where}; recall("${ref}") to retrieve]` +
		(preview ? `\n${preview}` : "")
	);
}

/**
 * Stage 1: replace old tool results with short stubs carrying a recall ref.
 * Uses the record's cached chars/preview — never re-joins the (possibly
 * multi-MB) original content on this per-LLM-call path.
 */
export const stubStage: Stage = ({ messages, state, settings, anchor }) => {
	return messages.map((m, i) => {
		if (i >= anchor || m.role !== "toolResult" || !m.toolCallId) return m;
		const rec = state.get(m.toolCallId);
		if (!rec) return m;
		if (state.turn - rec.turn < settings.stubAfterTurns) return m;
		if (state.inGrace(rec.ref)) return m;
		if (rec.chars <= settings.stubPreviewChars) return m; // not worth stubbing
		const stub = makeStub(rec.ref, rec.toolName, rec.chars, rec.preview, rec.spilled === true);
		return { ...m, content: [{ type: "text", text: stub }] };
	});
};

/** Stage 2: purge argument bodies of FAILED tool calls after a cooldown. */
export const purgeStage: Stage = ({ messages, state, settings }) => {
	const failed = new Set<string>();
	for (const m of messages) {
		if (m.role === "toolResult" && m.isError && m.toolCallId) {
			const rec = state.get(m.toolCallId);
			if (rec && state.turn - rec.turn >= settings.errorPurgeAfterTurns) failed.add(m.toolCallId);
		}
	}
	if (failed.size === 0) return messages;
	return messages.map((m) => {
		if (m.role !== "assistant" || !Array.isArray(m.content)) return m;
		let changed = false;
		const content = m.content.map((b) => {
			if (b.type === "toolCall" && failed.has((b as unknown as ToolCallBlock).id)) {
				changed = true;
				return { ...b, arguments: { _purged: "failed call; arguments removed by sliceofpi" } };
			}
			return b;
		});
		return changed ? { ...m, content } : m;
	});
};

/**
 * Stage 3: cap the view. Drop oldest CLOSED user turns (view only) until the
 * estimate fits liveTrimCap, then insert a synthetic marker. Durable
 * truncation is compaction's job, not this stage's.
 */
export const capStage: Stage = ({ messages, settings, anchor }) => {
	let total = 0;
	const sizes = messages.map((m) => {
		const t = estimateMessage(m);
		total += t;
		return t;
	});
	if (total <= settings.liveTrimCap) return messages;
	// walk turn starts oldest-first, dropping whole turns before the anchor
	let dropUpTo = 0;
	let i = 0;
	while (total > settings.liveTrimCap && i < anchor) {
		let next = i + 1;
		while (next < anchor && !isUserMessage(messages[next]!)) next++;
		for (let j = i; j < next; j++) total -= sizes[j]!;
		dropUpTo = next;
		i = next;
	}
	if (dropUpTo === 0) return messages;
	const marker: AgentMessage = {
		role: "user",
		customType: "sliceofpi:trim-marker",
		content: [
			{
				type: "text",
				text: `[sliceofpi: ${dropUpTo} older messages hidden from this call to control cost; recall(query) can search them]`,
			},
		],
	};
	return [marker, ...messages.slice(dropUpTo)];
};

/**
 * Final guard: tool-pair atomicity. Any toolCall whose toolResult is missing
 * from the view (or vice versa) is repaired by dropping the orphan side.
 * Runs LAST so no earlier stage can ship a broken view.
 */
export const boundaryStage: Stage = ({ messages }) => {
	const callIds = new Set<string>();
	for (const m of messages)
		if (m.role === "assistant" && Array.isArray(m.content))
			for (const b of m.content) if (b.type === "toolCall") callIds.add((b as unknown as ToolCallBlock).id);
	const resultIds = new Set<string>();
	for (const m of messages) if (m.role === "toolResult" && m.toolCallId) resultIds.add(m.toolCallId);

	return messages
		.filter((m) => !(m.role === "toolResult" && m.toolCallId && !callIds.has(m.toolCallId)))
		.map((m) => {
			if (m.role !== "assistant" || !Array.isArray(m.content)) return m;
			const content = m.content.filter(
				(b) => !(b.type === "toolCall" && !resultIds.has((b as unknown as ToolCallBlock).id)),
			);
			return content.length === m.content.length ? m : { ...m, content };
		})
		.filter((m) => !(Array.isArray(m.content) && m.content.length === 0));
};

export const DEFAULT_STAGES: Stage[] = [stubStage, purgeStage, capStage, boundaryStage];

/** Run the pipeline. Pure: input messages are never mutated. */
export function runPipeline(
	input: Omit<PipelineInput, "anchor">,
	stages: Stage[] = DEFAULT_STAGES,
): AgentMessage[] {
	// anchor is stable across stubStage/purgeStage (same-length transforms);
	// capStage consumes it before changing lengths, boundaryStage ignores it
	const anchor = anchorIndex(input.messages, input.settings.anchorUserMessages);
	let messages = input.messages;
	for (const stage of stages) messages = stage({ ...input, messages, anchor });
	return messages;
}
