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
	/** user-turn index when this result was produced */
	turn: number;
	/** absolute path of sidecar spill file, if spilled */
	spillPath?: string;
	/** user-turn index until which this record is grace-protected from stubbing */
	graceUntilTurn?: number;
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
	private nextRef = 1;
	/** user-turn clock: increments on each user message */
	turn = 0;
	/** flag set by the request_compact tool, honored at the turn boundary */
	compactRequested = false;
	/** big-task mode budget in tokens; undefined = normal mode */
	bigTaskBudget: number | undefined;
	/** cumulative session spend in USD (survives restarts via session entries) */
	spendUsd = 0;

	record(toolCallId: string, toolName: string, text: string, isError: boolean): ToolRecord {
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
			turn: this.turn,
			spillPath: dup?.spillPath,
			isError,
		};
		this.byId.set(toolCallId, rec);
		if (!dup) this.byHash.set(hash, rec);
		return rec;
	}

	get(toolCallId: string): ToolRecord | undefined {
		return this.byId.get(toolCallId);
	}

	byRef(ref: string): ToolRecord | undefined {
		for (const rec of this.byId.values()) if (rec.ref === ref) return rec;
		return undefined;
	}

	grantGrace(ref: string, untilTurn: number): void {
		for (const rec of this.byId.values())
			if (rec.ref === ref) rec.graceUntilTurn = Math.max(rec.graceUntilTurn ?? 0, untilTurn);
	}

	setSpill(toolCallId: string, path: string): void {
		const rec = this.byId.get(toolCallId);
		if (rec) rec.spillPath = path;
	}

	serialize(): PersistedIndex {
		return {
			nextRef: this.nextRef,
			records: [...this.byId.values()],
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
		for (const rec of data.records) {
			s.byId.set(rec.toolCallId, rec);
			if (!s.byHash.has(rec.hash)) s.byHash.set(rec.hash, rec);
		}
		return s;
	}
}

/** Extract plain text from a toolResult message's content. */
export function resultText(m: AgentMessage): string {
	if (typeof m.content === "string") return m.content;
	if (!Array.isArray(m.content)) return "";
	return m.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text")
		.map((b) => b.text)
		.join("\n");
}
