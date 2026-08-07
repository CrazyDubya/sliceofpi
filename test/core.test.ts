import { describe, expect, it } from "vitest";
import { advise, estimateTaskTokens } from "../src/advisor.ts";
import { compileSummary } from "../src/compaction.ts";
import { POKEE_ISAAC_10M, loadSettings, loadSettingsFromDisk, resolveTier } from "../src/config.ts";
import { turnCostUsd } from "../src/cost.ts";
import { HealthTracker } from "../src/health.ts";
import type { AgentMessage } from "../src/pi-types.ts";
import { bm25Search } from "../src/search.ts";
import { SliceState } from "../src/state.ts";
import { residentTokens } from "../src/tokens.ts";

const s = POKEE_ISAAC_10M;

describe("resolveTier", () => {
	it("maps absolute thresholds", () => {
		expect(resolveTier(50_000, s)).toBe("quiet");
		expect(resolveTier(120_000, s)).toBe("notice");
		expect(resolveTier(300_000, s)).toBe("advise");
		expect(resolveTier(450_000, s)).toBe("act");
		expect(resolveTier(2_000_000, s)).toBe("headroom");
	});
	it("tightens act threshold when health degrades", () => {
		// health 0 -> act fires at act * (1 - healthMaxTighten) = 200k
		expect(resolveTier(210_000, s, 0)).toBe("act");
		expect(resolveTier(210_000, s, 1)).toBe("notice");
	});
});

describe("cost", () => {
	it("prices a turn at Pokee rates", () => {
		// 1M resident + 4k out = 1M*0.15/1M + 4k*1.0/1M
		expect(turnCostUsd(1_000_000, 4_000, s)).toBeCloseTo(0.154, 3);
	});
});

describe("advise", () => {
	const base = {
		taskEstimateTokens: 0,
		sessionSpendUsd: 1,
		health: 1,
		bigTaskBudget: undefined,
		compactRequested: false,
		settings: s,
	};
	it("recommends compaction at advise tier without acting", () => {
		const a = advise({ ...base, residentTokens: 300_000 });
		expect(a.tier).toBe("advise");
		expect(a.notice).toContain("/slice compact");
		expect(a.shouldCompact).toBe(false);
	});
	it("auto-compacts at act tier", () => {
		const a = advise({ ...base, residentTokens: 450_000 });
		expect(a.shouldCompact).toBe(true);
	});
	it("big-task mode suspends auto-compaction within budget", () => {
		const a = advise({ ...base, residentTokens: 450_000, bigTaskBudget: 2_000_000 });
		expect(a.shouldCompact).toBe(false);
	});
	it("flags small task on fat tail", () => {
		const a = advise({ ...base, residentTokens: 300_000, taskEstimateTokens: 500 });
		expect(a.notice).toContain("conversation tail");
	});
	it("honors an agent compact request", () => {
		const a = advise({ ...base, residentTokens: 10_000, compactRequested: true });
		expect(a.shouldCompact).toBe(true);
	});
});

describe("estimateTaskTokens", () => {
	it("counts prompt and referenced file sizes", () => {
		expect(estimateTaskTokens("fix the bug", [4000])).toBe(3 + 1000);
	});
});

describe("residentTokens", () => {
	it("uses provider usage anchor plus trailing estimates", () => {
		const msgs: AgentMessage[] = [
			{ role: "user", content: [{ type: "text", text: "x".repeat(4000) }] },
			{ role: "assistant", content: [{ type: "text", text: "y" }], usage: { input: 5_000, output: 100 } },
			{ role: "user", content: [{ type: "text", text: "z".repeat(400) }] },
		];
		expect(residentTokens(msgs)).toBe(5_100 + 100);
	});
	it("falls back to pure estimation without usage", () => {
		const msgs: AgentMessage[] = [{ role: "user", content: [{ type: "text", text: "x".repeat(400) }] }];
		expect(residentTokens(msgs)).toBe(100);
	});
});

describe("SliceState", () => {
	it("dedups identical content to one ref and survives serialize/restore", () => {
		const st = new SliceState();
		st.turn = 3;
		const big = "same-output ".repeat(50); // >400 chars: stub-eligible, so persisted
		const a = st.record("id1", "bash", big, false);
		const b = st.record("id2", "bash", big, false);
		expect(a.ref).toBe(b.ref);
		const restored = SliceState.restore(st.serialize());
		expect(restored.get("id2")?.ref).toBe(a.ref);
		expect(restored.turn).toBe(3);
	});

	it("drops tiny clean records from persistence but keeps errors", () => {
		const st = new SliceState();
		st.record("small", "bash", "ok", false);
		st.record("err", "bash", "boom", true);
		const persisted = st.serialize();
		expect(persisted.records.map((r) => r.toolCallId)).toEqual(["err"]);
	});

	it("persists mode, compact request, and spend across restore", () => {
		const st = new SliceState();
		st.bigTaskBudget = 2_000_000;
		st.compactRequested = true;
		st.spendUsd = 1.23;
		const restored = SliceState.restore(st.serialize());
		expect(restored.bigTaskBudget).toBe(2_000_000);
		expect(restored.compactRequested).toBe(true);
		expect(restored.spendUsd).toBeCloseTo(1.23);
	});
});

describe("compileSummary", () => {
	it("compiles goal, files, commands deterministically", () => {
		const msgs: AgentMessage[] = [
			{ role: "user", content: [{ type: "text", text: "refactor the auth module" }] },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "reading" },
					{ type: "toolCall", id: "c1", name: "read", arguments: { path: "src/auth.ts" } },
					{ type: "toolCall", id: "c2", name: "edit", arguments: { path: "src/auth.ts" } },
					{ type: "toolCall", id: "c3", name: "bash", arguments: { command: "npm test" } },
				],
			},
		];
		const out = compileSummary(msgs, { readFiles: ["old.ts"] });
		expect(out.summary).toContain("refactor the auth module");
		expect(out.readFiles).toContain("src/auth.ts");
		expect(out.readFiles).toContain("old.ts"); // cumulative inheritance
		expect(out.modifiedFiles).toEqual(["src/auth.ts"]);
		expect(out.summary).toContain("npm test");
		// deterministic: same input, same output
		expect(compileSummary(msgs, { readFiles: ["old.ts"] }).summary).toBe(out.summary);
	});
});

describe("bm25Search", () => {
	it("ranks the doc containing query terms first", () => {
		const docs = [
			{ id: "t1", label: "t1", text: "npm install completed with 300 packages" },
			{ id: "t2", label: "t2", text: "database connection error: timeout connecting to postgres" },
			{ id: "t3", label: "t3", text: "all tests passed" },
		];
		const hits = bm25Search(docs, "postgres connection error");
		expect(hits[0]!.id).toBe("t2");
	});
	it("returns empty for no matches", () => {
		expect(bm25Search([{ id: "a", label: "a", text: "hello world" }], "zzzqqq")).toEqual([]);
	});
});

describe("HealthTracker", () => {
	it("degrades on repetition and errors", () => {
		const h = new HealthTracker();
		expect(h.score()).toBe(1);
		const loop = "the same exact phrase repeating again and again in output";
		for (let i = 0; i < 5; i++) h.noteAssistantText(loop);
		for (let i = 0; i < 10; i++) h.noteToolResult(true);
		expect(h.score()).toBeLessThan(0.5);
	});
});

describe("loadSettings", () => {
	it("merges nested tier overrides", () => {
		const merged = loadSettings({ tiers: { ...POKEE_ISAAC_10M.tiers, act: 999 } });
		expect(merged.tiers.act).toBe(999);
		expect(merged.tiers.notice).toBe(POKEE_ISAAC_10M.tiers.notice);
	});
});

describe("loadSettingsFromDisk", () => {
	it("merges sliceofpi keys with project settings winning over global", () => {
		const files: Record<string, string> = {
			"/home/.pi/agent/settings.json": JSON.stringify({ sliceofpi: { autoCompact: false, liveTrimCap: 111 } }),
			"/proj/.pi/settings.json": JSON.stringify({ sliceofpi: { liveTrimCap: 222 } }),
		};
		const s = loadSettingsFromDisk("/proj", (p) => files[p], "/home");
		expect(s.autoCompact).toBe(false); // from global
		expect(s.liveTrimCap).toBe(222); // project wins
		expect(s.tiers.act).toBe(POKEE_ISAAC_10M.tiers.act); // defaults intact
	});

	it("ignores malformed files and missing keys", () => {
		const s = loadSettingsFromDisk("/proj", (p) => (p.includes("agent") ? "{not json" : undefined), "/home");
		expect(s).toEqual(POKEE_ISAAC_10M);
	});
});
