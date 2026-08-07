/**
 * Offline benchmark: replay identical synthetic coding-session transcripts
 * through three strategies and compare cost, peak context, and retention.
 * Deterministic (seeded PRNG), no API key, no network. See DESIGN.md
 * "Benchmarking". Run: npm run bench
 *
 * Strategies:
 *   none      — no management (stock Pi on a 10M window: threshold never fires)
 *   native    — simulated stock-Pi compaction: summarize-older/keep-recent at
 *               a fixed threshold; summary modeled at 2k tokens + one
 *               summarizer call billed over the summarized span
 *   sliceofpi — the real shipped pipeline (stub/purge/cap/boundary) + real
 *               deterministic compaction at the same thresholds the extension
 *               uses. Not a model of the code: the code.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { POKEE_ISAAC_10M, loadSettings } from "../src/config.ts";
import { fmtTokens, turnCostUsd } from "../src/cost.ts";
import { compileSummary } from "../src/compaction.ts";
import type { AgentMessage } from "../src/pi-types.ts";
import { runPipeline } from "../src/pipeline.ts";
import { bm25Search, type SearchDoc } from "../src/search.ts";
import { SliceState, resultText } from "../src/state.ts";
import { estimateMessage } from "../src/tokens.ts";

// ---------- deterministic workload ------------------------------------------

function mulberry32(seed: number): () => number {
	let a = seed;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

interface Fact {
	id: string;
	text: string; // planted inside an early tool output
	query: string; // how the retention probe searches for it
}

interface Workload {
	turns: { prompt: string; toolResults: { text: string; isError: boolean }[] }[];
	facts: Fact[];
}

const WORDS =
	"config server deploy database migration auth token session cache index queue worker schema route handler module test build lint parse render commit branch merge patch buffer stream socket header payload retry timeout limit batch shard replica cluster metric trace log alert".split(
		" ",
	);

function makeWorkload(rand: () => number, turns: number): Workload {
	const facts: Fact[] = [];
	const out: Workload = { turns: [], facts };
	for (let t = 0; t < turns; t++) {
		const nResults = 1 + Math.floor(rand() * 3);
		const toolResults: { text: string; isError: boolean }[] = [];
		for (let r = 0; r < nResults; r++) {
			// heavy-tailed sizes: mostly 1-4k chars, occasionally 40-200k
			const big = rand() < 0.12;
			const chars = big ? 40_000 + Math.floor(rand() * 160_000) : 1_000 + Math.floor(rand() * 3_000);
			let text = "";
			while (text.length < chars) text += `${WORDS[Math.floor(rand() * WORDS.length)]} `;
			// plant a unique fact in ~1/3 of early-turn outputs
			if (t < turns / 2 && rand() < 0.33) {
				const id = `FACT_${facts.length}`;
				const secret = `${id}_VALUE_${Math.floor(rand() * 1e9)}`;
				text = `${text.slice(0, Math.floor(text.length / 2))} the ${id.toLowerCase()} setting equals ${secret} ${text.slice(Math.floor(text.length / 2))}`;
				facts.push({ id, text: secret, query: `${id.toLowerCase()} setting equals` });
			}
			toolResults.push({ text, isError: rand() < 0.08 });
		}
		out.turns.push({ prompt: `task ${t}: adjust the ${WORDS[Math.floor(rand() * WORDS.length)]} module`, toolResults });
	}
	return out;
}

// ---------- strategies -------------------------------------------------------

interface StrategyResult {
	name: string;
	billedInputTokens: number;
	billedOutputTokens: number;
	usd: number;
	peakResident: number;
	retention: number; // fraction of facts reachable at the end
	invariantsOk: boolean;
}

const OUT_PER_TURN = 800; // modeled assistant output tokens per turn
const S = POKEE_ISAAC_10M;

function billTurn(messages: AgentMessage[]): number {
	let tokens = 0;
	for (const m of messages) tokens += estimateMessage(m);
	return tokens;
}

function checkInvariants(messages: AgentMessage[]): boolean {
	const callIds = new Set<string>();
	for (const m of messages)
		if (m.role === "assistant" && Array.isArray(m.content))
			for (const b of m.content) if (b.type === "toolCall") callIds.add((b as unknown as { id: string }).id);
	for (const m of messages) if (m.role === "toolResult" && !callIds.has(m.toolCallId!)) return false;
	for (const id of callIds)
		if (!messages.some((m) => m.role === "toolResult" && m.toolCallId === id)) return false;
	return true;
}

function buildTurnMessages(w: Workload, t: number, callIdBase: string): AgentMessage[] {
	const turn = w.turns[t]!;
	const msgs: AgentMessage[] = [{ role: "user", content: [{ type: "text", text: turn.prompt }] }];
	const calls = turn.toolResults.map((_, r) => ({ type: "toolCall", id: `${callIdBase}_${r}`, name: "bash", arguments: { command: `step ${r}` } }));
	msgs.push({ role: "assistant", content: [{ type: "text", text: `working on task ${t}` }, ...(calls as never[])] });
	turn.toolResults.forEach((res, r) =>
		msgs.push({ role: "toolResult", toolCallId: `${callIdBase}_${r}`, toolName: "bash", isError: res.isError, content: [{ type: "text", text: res.text }] }),
	);
	return msgs;
}

function runNone(w: Workload): StrategyResult {
	const transcript: AgentMessage[] = [];
	let billed = 0;
	let peak = 0;
	let ok = true;
	for (let t = 0; t < w.turns.length; t++) {
		transcript.push(...buildTurnMessages(w, t, `n${t}`));
		const tokens = billTurn(transcript);
		billed += tokens;
		peak = Math.max(peak, tokens);
		ok &&= checkInvariants(transcript);
	}
	// retention: everything is inline
	return finalize("none", billed, w.turns.length, peak, 1, ok);
}

function runNative(w: Workload, threshold = S.tiers.act): StrategyResult {
	let transcript: AgentMessage[] = [];
	let billed = 0;
	let peak = 0;
	let ok = true;
	let summaryCarried: string | undefined;
	for (let t = 0; t < w.turns.length; t++) {
		transcript.push(...buildTurnMessages(w, t, `v${t}`));
		const tokens = billTurn(transcript);
		billed += tokens;
		peak = Math.max(peak, tokens);
		ok &&= checkInvariants(transcript);
		if (tokens > threshold) {
			// summarize-older/keep-recent: bill one summarizer call over the span
			let keep = transcript.length;
			let keptTokens = 0;
			while (keep > 0 && keptTokens < S.keepRecentTokens) keptTokens += estimateMessage(transcript[--keep]!);
			// cut at a user boundary
			while (keep > 0 && transcript[keep]!.role !== "user") keep--;
			const span = transcript.slice(0, keep);
			billed += billTurn(span); // summarizer input
			summaryCarried = `[summary of ${span.length} messages]`.padEnd(8_000, " "); // ~2k tokens
			transcript = [
				{ role: "user", customType: "summary", content: [{ type: "text", text: summaryCarried }] },
				...transcript.slice(keep),
			];
		}
	}
	// retention: facts only survive inside the (lossy) LLM summary — model the
	// generous case that a summary preserves 20% of planted facts.
	const retention = summaryCarried ? 0.2 : 1;
	return finalize("native", billed, w.turns.length, peak, retention, ok);
}

function runSlice(w: Workload): StrategyResult {
	const settings = loadSettings();
	const state = new SliceState();
	let transcript: AgentMessage[] = [];
	const spilled = new Map<string, string>(); // ref -> full text (in-memory spill)
	// analog of the session JSONL: Pi retains all entries on disk even after
	// compaction, and the real searchDocs() reads them — recall can reach
	// everything ever indexed, not just spilled blobs.
	const sessionLog = new Map<string, string>(); // ref -> full text
	let billed = 0;
	let peak = 0;
	let ok = true;
	let previous: { summary?: string; readFiles?: string[]; modifiedFiles?: string[] } | undefined;

	for (let t = 0; t < w.turns.length; t++) {
		state.turn++;
		const turnMsgs = buildTurnMessages(w, t, `s${t}`);
		for (const m of turnMsgs)
			if (m.role === "toolResult" && m.toolCallId) {
				const text = resultText(m);
				const rec = state.record(m.toolCallId, "bash", text, m.isError === true);
				sessionLog.set(rec.ref, text);
				if (text.length > settings.spillThresholdChars && !spilled.has(rec.ref)) {
					spilled.set(rec.ref, text);
					state.setSpilled(m.toolCallId);
				}
			}
		transcript.push(...turnMsgs);
		const view = runPipeline({ messages: transcript, state, settings });
		const tokens = billTurn(view);
		billed += tokens;
		peak = Math.max(peak, tokens);
		ok &&= checkInvariants(view);
		if (tokens > settings.tiers.act) {
			// deterministic compaction: zero LLM cost
			const compiled = compileSummary(transcript, previous);
			previous = { summary: compiled.summary, readFiles: compiled.readFiles, modifiedFiles: compiled.modifiedFiles };
			let keep = transcript.length;
			let keptTokens = 0;
			while (keep > 0 && keptTokens < settings.keepRecentTokens) keptTokens += estimateMessage(transcript[--keep]!);
			while (keep > 0 && transcript[keep]!.role !== "user") keep--;
			transcript = [
				{ role: "user", customType: "summary", content: [{ type: "text", text: compiled.summary }] },
				...transcript.slice(keep),
			];
		}
	}

	// retention probe: a fact is reachable if inline in the final view, or via
	// recall(ref) of a spilled/indexed record, or via BM25 over the index.
	const finalView = runPipeline({ messages: transcript, state, settings });
	const inlineText = finalView.map((m) => resultText(m)).join("\n");
	const docs: SearchDoc[] = [...sessionLog.entries()].map(([ref, text]) => ({ id: ref, label: ref, text }));
	let reachable = 0;
	for (const fact of w.facts) {
		const inline = inlineText.includes(fact.text);
		// reachable via recall only if BM25 actually surfaces the right doc
		const viaSearch = bm25Search(docs, fact.query, 5).some((h) => sessionLog.get(h.id)?.includes(fact.text));
		if (inline || viaSearch) reachable++;
	}
	return finalize("sliceofpi", billed, w.turns.length, peak, w.facts.length ? reachable / w.facts.length : 1, ok);
}

function finalize(name: string, billedIn: number, turns: number, peak: number, retention: number, ok: boolean): StrategyResult {
	const billedOut = turns * OUT_PER_TURN;
	return {
		name,
		billedInputTokens: billedIn,
		billedOutputTokens: billedOut,
		usd: turnCostUsd(billedIn, billedOut, S),
		peakResident: peak,
		retention,
		invariantsOk: ok,
	};
}

// ---------- main -------------------------------------------------------------

const SEEDS = [1, 2, 3];
const TURNS = 60;
const rows: (StrategyResult & { seed: number })[] = [];
for (const seed of SEEDS) {
	const w = makeWorkload(mulberry32(seed), TURNS);
	rows.push({ ...runNone(w), seed }, { ...runNative(w), seed }, { ...runSlice(w), seed });
}

const byName = new Map<string, StrategyResult[]>();
for (const r of rows) byName.set(r.name, [...(byName.get(r.name) ?? []), r]);

console.log(`\nsliceofpi offline benchmark — ${SEEDS.length} seeds × ${TURNS} turns, Pokee-Isaac pricing ($${S.priceInPerM}/M in, $${S.priceOutPerM}/M out)\n`);
console.log("strategy    | billed input | $ total  | peak ctx | retention | invariants");
console.log("------------|--------------|----------|----------|-----------|-----------");
for (const [name, rs] of byName) {
	const avg = (f: (r: StrategyResult) => number) => rs.reduce((a, r) => a + f(r), 0) / rs.length;
	console.log(
		`${name.padEnd(11)} | ${fmtTokens(avg((r) => r.billedInputTokens)).padStart(12)} | $${avg((r) => r.usd).toFixed(2).padStart(7)} | ${fmtTokens(avg((r) => r.peakResident)).padStart(8)} | ${(avg((r) => r.retention) * 100).toFixed(0).padStart(8)}% | ${rs.every((r) => r.invariantsOk) ? "ok" : "VIOLATED"}`,
	);
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), "results");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "latest.json"), JSON.stringify(rows, null, 2));
console.log(`\nraw rows -> bench/results/latest.json`);
console.log(
	"note: retention for `native` is a modeled constant (LLM summaries are lossy, generously assumed 20%);\n" +
		"`none` and `sliceofpi` retention are measured. Model-quality effects require a live A/B (see DESIGN.md).",
);
