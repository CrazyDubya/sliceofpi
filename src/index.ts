/**
 * sliceofpi — Pi extension entry point. Wires the five layers (DESIGN.md)
 * into Pi's hook lifecycle:
 *
 *   tool_result        -> index + eager spill (L2)
 *   context            -> live per-call trim pipeline (L1)
 *   before_agent_start -> task sizing + tier advice (L4/L5)
 *   turn_end / agent_settled -> health tracking, deferred auto-compact (L4)
 *   session_before_compact   -> deterministic render (L3, sole owner)
 *   session_start      -> restore state from session entries
 *
 * See NOTICE.md for upstream attribution.
 */

import { statSync } from "node:fs";
import { advise, estimateTaskTokens, type Advice } from "./advisor.ts";
import { compileSummary } from "./compaction.ts";
import { loadSettings, loadSettingsFromDisk, type SliceSettings, type Tier } from "./config.ts";
import { fmtTokens, fmtUsd } from "./cost.ts";
import { HealthTracker } from "./health.ts";
import type { AgentMessage, ExtensionAPI, ExtensionContext, SessionEntry } from "./pi-types.ts";
import { runPipeline } from "./pipeline.ts";
import { bm25Search, type SearchDoc } from "./search.ts";
import { gcBlobs, readSpill, spill } from "./spill.ts";
import { ENTRY_TYPE, resultText, SliceState, type PersistedIndex } from "./state.ts";
import { residentTokens } from "./tokens.ts";

export default function sliceofpi(pi: ExtensionAPI): void {
	let settings: SliceSettings = loadSettings();
	let state = new SliceState();
	const health = new HealthTracker();
	let lastResident = 0;
	const TIER_ORDER: Tier[] = ["quiet", "notice", "advise", "act", "headroom"];
	let lastNoticedTier: Tier = "quiet";
	let lastMessages: AgentMessage[] = [];
	let lastPreviousSummary: { summary?: string; readFiles?: string[]; modifiedFiles?: string[] } | undefined;

	// ---- restore state from session entries (restart-safe) -----------------
	pi.on("session_start", async (_event, ctx) => {
		settings = loadSettingsFromDisk(ctx.cwd);
		const entries = ctx.sessionManager.getBranchEntries?.() ?? ctx.sessionManager.getEntries?.() ?? [];
		let persisted: PersistedIndex | undefined;
		for (const e of entries) {
			if (e.type === "custom" && e.customType === ENTRY_TYPE) persisted = e.data as PersistedIndex;
			if (e.type === "compaction") {
				const details = (e as { details?: { readFiles?: string[]; modifiedFiles?: string[] } }).details;
				lastPreviousSummary = { summary: (e as { summary?: string }).summary, ...details };
			}
		}
		state = SliceState.restore(persisted);
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (sessionFile) {
			const liveRefs = new Set(state.serialize().records.map((r) => r.ref));
			gcBlobs(sessionFile, liveRefs);
		}
		updateFooter(ctx);
	});

	// ---- L2: index + spill every tool result --------------------------------
	pi.on("tool_result", async (event, ctx) => {
		const text = contentText(event.content);
		state.record(event.toolCallId, event.toolName, text, event.isError === true);
		health.noteToolResult(event.isError === true);
		if (text.length > settings.spillThresholdChars) {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (sessionFile) {
				const rec = state.get(event.toolCallId);
				if (rec && !rec.spillPath) state.setSpill(event.toolCallId, spill(sessionFile, rec.ref, text));
			}
		}
	});

	// ---- L1: trim the outbound view on every LLM call -----------------------
	pi.on("context", async (event, _ctx) => {
		lastMessages = event.messages;
		const trimmed = runPipeline({ messages: event.messages, state, settings });
		return { messages: trimmed };
	});

	// ---- L4/L5: task sizing + advice at prompt time -------------------------
	pi.on("before_agent_start", async (event, ctx) => {
		state.turn++;
		const resident = currentResident(ctx);
		const advice = advise({
			residentTokens: resident,
			taskEstimateTokens: estimateTaskTokens(event.prompt ?? "", referencedFileSizes(event.prompt ?? "", ctx.cwd)),
			sessionSpendUsd: state.spendUsd,
			health: health.score(),
			bigTaskBudget: state.bigTaskBudget,
			compactRequested: state.compactRequested,
			settings,
		});
		updateFooter(ctx, advice.footer);
		deliverNotice(advice, ctx);
	});

	// ---- track spend + health from assistant messages -----------------------
	pi.on("message_end", async (event, _ctx) => {
		const m = event.message as AgentMessage;
		if (m.role !== "assistant") return;
		const cost = m.usage?.cost?.total;
		if (typeof cost === "number" && cost > 0) state.spendUsd += cost;
		else if (m.usage) {
			const inTok = (m.usage.input ?? 0) + (m.usage.cacheRead ?? 0) + (m.usage.cacheWrite ?? 0);
			state.spendUsd += (inTok * settings.priceInPerM + (m.usage.output ?? 0) * settings.priceOutPerM) / 1e6;
		}
		health.noteAssistantText(assistantText(m));
	});

	// ---- deferred auto-compact at the settled boundary ----------------------
	pi.on("agent_settled", async (_event, ctx) => {
		pi.appendEntry(ENTRY_TYPE, state.serialize());
		const resident = currentResident(ctx);
		const advice = advise({
			residentTokens: resident,
			taskEstimateTokens: 0,
			sessionSpendUsd: state.spendUsd,
			health: health.score(),
			bigTaskBudget: state.bigTaskBudget,
			compactRequested: state.compactRequested,
			settings,
		});
		updateFooter(ctx, advice.footer);
		if (advice.shouldCompact && ctx.isIdle()) {
			state.compactRequested = false;
			ctx.compact({
				onComplete: () => ctx.ui.notify("sliceofpi: compacted", "info"),
				onError: (err) => ctx.ui.notify(`sliceofpi: compaction failed: ${err.message}`, "error"),
			});
		}
	});

	// ---- L3: sole owner of session_before_compact ---------------------------
	pi.on("session_before_compact", async (event, _ctx) => {
		const prep = event.preparation;
		const span: AgentMessage[] = [
			...(prep?.messagesToSummarize ?? []),
			...(prep?.turnPrefixMessages ?? []),
		];
		const source = span.length > 0 ? span : lastMessages;
		const compiled = compileSummary(source, lastPreviousSummary ?? prep?.previousSummary);
		return {
			compaction: {
				summary: compiled.summary,
				firstKeptEntryId: prep?.firstKeptEntryId,
				tokensBefore: prep?.tokensBefore ?? lastResident,
				details: { readFiles: compiled.readFiles, modifiedFiles: compiled.modifiedFiles, deterministic: true },
			},
		};
	});

	// ---- recall tool (L2) ---------------------------------------------------
	pi.registerTool({
		name: "recall",
		description:
			"Retrieve stubbed/hidden context: pass ref (e.g. \"t12\") to fetch a stubbed tool output verbatim, or query to BM25-search all indexed outputs.",
		parameters: {
			type: "object",
			properties: {
				ref: { type: "string", description: "tool-output ref like t12" },
				query: { type: "string", description: "free-text search query" },
			},
		},
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			if (typeof params.ref === "string") {
				const rec = state.byRef(params.ref.trim());
				if (!rec) throw new Error(`No record for ${params.ref}`);
				state.grantGrace(rec.ref, state.turn + settings.recoveryGraceTurns);
				if (rec.spillPath) {
					const { text, truncated } = readSpill(rec.spillPath);
					return {
						content: [{ type: "text", text: truncated ? `${text}\n[truncated by sliceofpi]` : text }],
					};
				}
				const inline = findInline(lastMessages, rec.toolCallId);
				if (inline) return { content: [{ type: "text", text: inline }] };
				throw new Error(
					`${params.ref}: content no longer inline and was not spilled (only ${rec.chars} chars; likely still visible upstream)`,
				);
			}
			if (typeof params.query === "string") {
				const docs = searchDocs(ctx);
				const hits = bm25Search(docs, params.query, 5);
				if (hits.length === 0) return { content: [{ type: "text", text: "No matches." }] };
				const text = hits.map((h) => `${h.label} (score ${h.score.toFixed(2)})\n${h.excerpt}`).join("\n---\n");
				return { content: [{ type: "text", text }] };
			}
			throw new Error("Pass ref or query.");
		},
	});

	// ---- agent self-service tools (pi-context-tools pattern) ----------------
	pi.registerTool({
		name: "context_info",
		description: "Current context usage, tier, and per-turn cost.",
		parameters: { type: "object", properties: {} },
		execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
			const resident = currentResident(ctx);
			const a = advise({
				residentTokens: resident,
				taskEstimateTokens: 0,
				sessionSpendUsd: state.spendUsd,
				health: health.score(),
				bigTaskBudget: state.bigTaskBudget,
				compactRequested: state.compactRequested,
				settings,
			});
			return { content: [{ type: "text", text: a.footer }] };
		},
	});

	pi.registerTool({
		name: "request_compact",
		description: "Request compaction; it fires at the next turn boundary (never mid-turn).",
		parameters: { type: "object", properties: {} },
		execute: async (_toolCallId, _params, _signal, _onUpdate, _ctx) => {
			state.compactRequested = true;
			return { content: [{ type: "text", text: "Compaction scheduled for the next turn boundary." }] };
		},
	});

	// ---- /slice command -----------------------------------------------------
	pi.registerCommand("slice", {
		description: "sliceofpi: status | compact | big <tokens> | normal | auto on|off",
		handler: async (args, ctx) => {
			const [cmd, arg] = args.trim().split(/\s+/);
			if (!cmd || cmd === "status") {
				const resident = currentResident(ctx);
				ctx.ui.notify(
					`sliceofpi ${settings.profile}: ${fmtTokens(resident)} resident | spent ${fmtUsd(state.spendUsd)} | ` +
						`mode ${state.bigTaskBudget ? `big(${fmtTokens(state.bigTaskBudget)})` : "normal"} | auto ${settings.autoCompact ? "on" : "off"} | health ${health.score().toFixed(2)}`,
					"info",
				);
			} else if (cmd === "compact") {
				state.compactRequested = true;
				ctx.ui.notify("Compaction scheduled for the next turn boundary.", "info");
			} else if (cmd === "big") {
				state.bigTaskBudget = arg ? parseTokens(arg) : 2_000_000;
				ctx.ui.notify(`Big-task mode: auto-compaction suspended up to ${fmtTokens(state.bigTaskBudget)} tokens.`, "warn");
			} else if (cmd === "normal") {
				state.bigTaskBudget = undefined;
				ctx.ui.notify("Normal mode restored. /slice compact recommended if the big task is done.", "info");
			} else if (cmd === "auto") {
				settings = { ...settings, autoCompact: arg !== "off" };
				ctx.ui.notify(`Auto-compact ${settings.autoCompact ? "on" : "off"}.`, "info");
			} else {
				ctx.ui.notify("Usage: /slice status|compact|big <tokens>|normal|auto on|off", "info");
			}
		},
	});

	// ---- helpers ------------------------------------------------------------

	function currentResident(ctx: ExtensionContext): number {
		const usage = ctx.getContextUsage();
		lastResident = usage?.tokens ?? (lastMessages.length > 0 ? residentTokens(lastMessages) : lastResident);
		return lastResident;
	}

	function updateFooter(ctx: ExtensionContext, text?: string): void {
		const line = text ?? `sliceofpi ${settings.profile}`;
		if (ctx.ui.setWidget) {
			const mode = state.bigTaskBudget ? `big(${fmtTokens(state.bigTaskBudget)})` : "normal";
			ctx.ui.setWidget("sliceofpi", [line, `mode ${mode} | auto-compact ${settings.autoCompact ? "on" : "off"}`]);
		} else {
			ctx.ui.setStatus("sliceofpi", line);
		}
	}

	/**
	 * Advisory delivery: tier escalations to act/headroom go into the session
	 * as a visible message at the next turn boundary (deliverAs "nextTurn"),
	 * so both the user AND the model see them; everything else is a UI notify.
	 */
	function deliverNotice(advice: Advice, ctx: ExtensionContext): void {
		const escalated = TIER_ORDER.indexOf(advice.tier) > TIER_ORDER.indexOf(lastNoticedTier);
		lastNoticedTier = advice.tier;
		if (!advice.notice) return;
		if (escalated && (advice.tier === "act" || advice.tier === "headroom") && pi.sendMessage) {
			pi.sendMessage(
				{ customType: "sliceofpi:advice", content: advice.notice, display: true },
				{ deliverAs: "nextTurn" },
			);
		} else {
			ctx.ui.notify(advice.notice, advice.tier === "advise" ? "info" : "warn");
		}
	}

	function searchDocs(ctx: ExtensionContext): SearchDoc[] {
		const docs: SearchDoc[] = [];
		const entries = ctx.sessionManager.getBranchEntries?.() ?? ctx.sessionManager.getEntries?.() ?? [];
		for (const e of entries as SessionEntry[]) {
			const m = e.message;
			if (!m || m.role !== "toolResult" || !m.toolCallId) continue;
			const rec = state.get(m.toolCallId);
			const text = rec?.spillPath ? readSpill(rec.spillPath, 200_000).text : resultText(m);
			if (!text) continue;
			docs.push({
				id: rec?.ref ?? e.id,
				label: rec ? `${rec.ref} (${rec.toolName}, turn ${rec.turn})` : e.id,
				text,
			});
		}
		return docs;
	}
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b): b is { type: "text"; text: string } => (b as { type?: string }).type === "text")
		.map((b) => b.text)
		.join("\n");
}

function assistantText(m: AgentMessage): string {
	if (typeof m.content === "string") return m.content;
	if (!Array.isArray(m.content)) return "";
	return m.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text")
		.map((b) => b.text)
		.join("\n");
}

function findInline(messages: AgentMessage[], toolCallId: string): string | undefined {
	for (const m of messages)
		if (m.role === "toolResult" && m.toolCallId === toolCallId) {
			const text = resultText(m);
			if (text && !text.startsWith("[sliceofpi:")) return text;
		}
	return undefined;
}

function referencedFileSizes(prompt: string, cwd: string): number[] {
	const sizes: number[] = [];
	const candidates = prompt.match(/[\w./~-]+\.[a-z]{1,8}\b/gi) ?? [];
	for (const c of candidates.slice(0, 20)) {
		try {
			const path = c.startsWith("/") ? c : `${cwd}/${c}`;
			const st = statSync(path);
			if (st.isFile()) sizes.push(st.size);
		} catch {
			// not a real file reference; ignore
		}
	}
	return sizes;
}

function parseTokens(arg: string): number {
	const m = arg.toLowerCase().match(/^(\d+(?:\.\d+)?)([km]?)$/);
	if (!m) return 2_000_000;
	const n = Number(m[1]);
	return m[2] === "m" ? n * 1_000_000 : m[2] === "k" ? n * 1_000 : n;
}
