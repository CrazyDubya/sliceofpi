/**
 * Session-scoped state: the tool-result index and turn clock.
 *
 * Indexer design adapted from pi-condense (MIT,
 * https://github.com/jjuraszek/pi-condense — src/indexer.ts): short refs
 * (t1, t2, ...), content-hash dedup, rebuilt from session entries on start so
 * everything survives restarts and branch switches. Persistence is via Pi
 * session custom entries, the pi-condense / pi-observational-memory pattern.
 */

import { createHash } from "node:crypto";
import type { AgentMessage } from "./pi-types.ts";

export interface ToolRecord {
	ref: string; // t<N>
	toolCallId: string;
	toolName: string;
	hash: string;
	chars: number;
	/** head of the output, captured once at record() time for stub rendering */
	preview: string;
	/** user-turn index when this result was produced */
	turn: number;
	/** output was spilled to <sessionDir>/<sessionId>-blobs/<ref>.txt */
	spilled?: boolean;
	isError?: boolean;
}

export interface PersistedIndex {
	nextRef: number;
	records: ToolRecord[];
	turn: number;
	compactRequested?: boolean;
	bigTaskBudget?: number;
	spendUsd?: number;
}

export const ENTRY_TYPE = "sliceofpi:index";

export function contentHash(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export class SliceState {
	private byId = new Map<string, ToolRecord>();
	private byHash = new Map<string, ToolRecord>();
	/** every record sharing a ref (content-hash dedup aliases) */
	private refMap = new Map<string, ToolRecord[]>();
	/** ref -> protected-through user turn (recall recovery grace) */
	private grace = new Map<string, number>();
	private nextRef = 1;
	/** user-turn clock: derived from the transcript on every context event */
	turn = 0;
	/** flag set by the request_compact tool, honored at the turn boundary */
	compactRequested = false;
	/** big-task mode budget in tokens; undefined = normal mode */
	bigTaskBudget: number | undefined;
	/** cumulative session spend in USD (survives restarts via session entries) */
	spendUsd = 0;

	record(toolCallId: string, toolName: string, text: string, isError: boolean, previewChars = 400): ToolRecord {
		const existing = this.byId.get(toolCallId);
		if (existing) return existing;
		const hash = contentHash(text);
		const dup = this.byHash.get(hash);
		const rec: ToolRecord = {
			ref: dup ? dup.ref : `t${this.nextRef++}`,
			toolCallId,
			toolName,
			hash,
			chars: text.length,
			preview: text.slice(0, previewChars),
			turn: this.turn,
			spilled: dup?.spilled,
			isError,
		};
		this.index(rec);
		return rec;
	}

	private index(rec: ToolRecord): void {
		this.byId.set(rec.toolCallId, rec);
		if (!this.byHash.has(rec.hash)) this.byHash.set(rec.hash, rec);
		const aliases = this.refMap.get(rec.ref);
		if (aliases) aliases.push(rec);
		else this.refMap.set(rec.ref, [rec]);
	}

	get(toolCallId: string): ToolRecord | undefined {
		return this.byId.get(toolCallId);
	}

	byRef(ref: string): ToolRecord | undefined {
		return this.refMap.get(ref)?.[0];
	}

	refs(): Set<string> {
		return new Set(this.refMap.keys());
	}

	grantGrace(ref: string, untilTurn: number): void {
		this.grace.set(ref, Math.max(this.grace.get(ref) ?? 0, untilTurn));
	}

	inGrace(ref: string): boolean {
		const until = this.grace.get(ref);
		return until !== undefined && this.turn <= until;
	}

	setSpilled(toolCallId: string): void {
		const rec = this.byId.get(toolCallId);
		if (rec) for (const alias of this.refMap.get(rec.ref) ?? []) alias.spilled = true;
	}

	/**
	 * Persist only records that can still matter after a restart: stub
	 * candidates (larger than the preview), errors (purge targets), and
	 * spilled blobs. minChars must equal settings.stubPreviewChars so the
	 * persistence filter and the stub policy agree.
	 */
	serialize(minChars = 400): PersistedIndex {
		const records = [...this.byId.values()].filter((r) => r.isError || r.spilled || r.chars > minChars);
		return {
			nextRef: this.nextRef,
			records,
			turn: this.turn,
			compactRequested: this.compactRequested,
			bigTaskBudget: this.bigTaskBudget,
			spendUsd: this.spendUsd,
		};
	}

	static restore(data: PersistedIndex | undefined): SliceState {
		const s = new SliceState();
		if (!data) return s;
		s.nextRef = data.nextRef;
		s.turn = data.turn;
		s.compactRequested = data.compactRequested ?? false;
		s.bigTaskBudget = data.bigTaskBudget;
		s.spendUsd = data.spendUsd ?? 0;
		for (const rec of data.records) s.index({ ...rec, preview: rec.preview ?? "" });
		return s;
	}
}

/** Join the text blocks of message content into one string. */
export function textOf(content: AgentMessage["content"]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b): b is { type: "text"; text: string } => b.type === "text")
		.map((b) => b.text)
		.join("\n");
}

/** Extract plain text from a message. */
export function resultText(m: AgentMessage): string {
	return textOf(m.content);
}
