import { describe, expect, it } from "vitest";
import { POKEE_ISAAC_10M, loadSettings } from "../src/config.ts";
import type { AgentMessage } from "../src/pi-types.ts";
import { anchorIndex, boundaryStage, capStage, purgeStage, runPipeline, stubStage } from "../src/pipeline.ts";
import { SliceState, resultText } from "../src/state.ts";

function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }] };
}
function assistant(text: string, toolCalls: { id: string; name: string; args?: Record<string, unknown> }[] = []): AgentMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text },
			...toolCalls.map((t) => ({ type: "toolCall", id: t.id, name: t.name, arguments: t.args ?? {} })),
		],
	};
}
function toolResult(id: string, text: string, isError = false): AgentMessage {
	return { role: "toolResult", toolCallId: id, toolName: "bash", isError, content: [{ type: "text", text }] };
}

const settings = loadSettings({ stubAfterTurns: 1, anchorUserMessages: 1, stubPreviewChars: 50 });

function buildState(msgs: AgentMessage[], turn: number): SliceState {
	const s = new SliceState();
	let t = 0;
	for (const m of msgs) {
		if (m.role === "user" && !m.customType) t++;
		s.turn = t;
		if (m.role === "toolResult" && m.toolCallId) s.record(m.toolCallId, m.toolName ?? "bash", resultText(m), m.isError === true);
	}
	s.turn = turn;
	return s;
}

describe("stubStage", () => {
	it("stubs old large tool results with a recall ref and keeps recent ones", () => {
		const big = "x".repeat(500);
		const msgs = [user("q1"), assistant("a", [{ id: "c1", name: "bash" }]), toolResult("c1", big), user("q2"), assistant("b", [{ id: "c2", name: "bash" }]), toolResult("c2", big)];
		const state = buildState(msgs, 2);
		const out = stubStage({ messages: msgs, state, settings });
		expect(resultText(out[2]!)).toContain('recall("t1")');
		expect(resultText(out[5]!)).toBe(big); // inside anchor: untouched
	});

	it("respects recovery grace", () => {
		const big = "y".repeat(500);
		const msgs = [user("q1"), assistant("a", [{ id: "c1", name: "bash" }]), toolResult("c1", big), user("q2"), user("q3")];
		const state = buildState(msgs, 3);
		state.grantGrace("t1", 5);
		const out = stubStage({ messages: msgs, state, settings });
		expect(resultText(out[2]!)).toBe(big);
	});

	it("leaves small results inline", () => {
		const msgs = [user("q1"), assistant("a", [{ id: "c1", name: "bash" }]), toolResult("c1", "tiny"), user("q2")];
		const state = buildState(msgs, 2);
		const out = stubStage({ messages: msgs, state, settings });
		expect(resultText(out[2]!)).toBe("tiny");
	});
});

describe("purgeStage", () => {
	it("purges arguments of failed calls after cooldown, keeps the error result", () => {
		const msgs = [
			user("q1"),
			assistant("a", [{ id: "c1", name: "bash", args: { command: "secret-huge-arg" } }]),
			toolResult("c1", "boom", true),
			user("q2"),
			user("q3"),
			user("q4"),
		];
		const state = buildState(msgs, 4);
		const out = purgeStage({ messages: msgs, state, settings });
		const call = (out[1]!.content as any[]).find((b) => b.type === "toolCall");
		expect(call.arguments._purged).toBeDefined();
		expect(resultText(out[2]!)).toBe("boom");
	});
});

describe("capStage", () => {
	it("drops oldest closed turns when over cap and inserts a marker", () => {
		const big = "z".repeat(4000); // ~1000 tokens each
		const msgs: AgentMessage[] = [];
		for (let i = 0; i < 10; i++) {
			msgs.push(user(`q${i}`), assistant(big));
		}
		const tight = { ...settings, liveTrimCap: 3_000 };
		const state = buildState(msgs, 10);
		const out = capStage({ messages: msgs, state, settings: tight });
		expect(out.length).toBeLessThan(msgs.length);
		expect(out[0]!.customType).toBe("sliceofpi:trim-marker");
		// newest turn survives
		expect(resultText(out[out.length - 1]!) || (out[out.length - 1]!.content as any[])[0].text).toBeDefined();
	});

	it("no-ops under the cap", () => {
		const msgs = [user("q"), assistant("a")];
		const state = buildState(msgs, 1);
		expect(capStage({ messages: msgs, state, settings })).toEqual(msgs);
	});
});

describe("boundaryStage", () => {
	it("drops orphaned toolResults and orphaned toolCalls", () => {
		const msgs = [
			user("q"),
			assistant("a", [{ id: "kept", name: "bash" }, { id: "orphan-call", name: "bash" }]),
			toolResult("kept", "ok"),
			toolResult("orphan-result", "??"),
		];
		const state = buildState(msgs, 1);
		const out = boundaryStage({ messages: msgs, state, settings });
		expect(out.some((m) => m.toolCallId === "orphan-result")).toBe(false);
		const calls = (out[1]!.content as any[]).filter((b) => b.type === "toolCall");
		expect(calls.map((c) => c.id)).toEqual(["kept"]);
	});
});

describe("runPipeline invariants", () => {
	it("never ships a toolCall/toolResult mismatch and never mutates input", () => {
		const big = "w".repeat(9000);
		const msgs: AgentMessage[] = [];
		for (let i = 0; i < 30; i++) {
			msgs.push(user(`task ${i}`), assistant(`working ${i}`, [{ id: `c${i}`, name: "bash" }]), toolResult(`c${i}`, big, i % 5 === 0));
		}
		const snapshot = JSON.parse(JSON.stringify(msgs));
		const state = buildState(msgs, 30);
		const out = runPipeline({ messages: msgs, state, settings: { ...settings, liveTrimCap: 20_000 } });
		expect(msgs).toEqual(snapshot); // pure
		const callIds = new Set<string>();
		for (const m of out)
			if (m.role === "assistant" && Array.isArray(m.content))
				for (const b of m.content as any[]) if (b.type === "toolCall") callIds.add(b.id);
		for (const m of out) if (m.role === "toolResult") expect(callIds.has(m.toolCallId!)).toBe(true);
		for (const id of callIds) expect(out.some((m) => m.role === "toolResult" && m.toolCallId === id)).toBe(true);
	});
});

describe("anchorIndex", () => {
	it("finds the Nth-from-last real user message", () => {
		const msgs = [user("a"), assistant("x"), user("b"), assistant("y"), user("c")];
		expect(anchorIndex(msgs, 1)).toBe(4);
		expect(anchorIndex(msgs, 2)).toBe(2);
		expect(anchorIndex(msgs, 99)).toBe(0);
	});
});

describe("settings", () => {
	it("profile defaults are absolute and sane for 10M", () => {
		expect(POKEE_ISAAC_10M.tiers.act).toBeLessThan(1_000_000);
		expect(POKEE_ISAAC_10M.tiers.notice).toBeGreaterThanOrEqual(50_000);
	});
});
