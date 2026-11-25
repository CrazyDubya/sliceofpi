// Drives the REAL extension (src/index.ts) through a fake Pi host: two branches of one
// session file, both producing a spilled "t1". Module-level fake, not a live Pi session.
import { expect, test } from "vitest";
import { mkdtempSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sliceofpi from "../src/index.ts";
import { ENTRY_TYPE } from "../src/state.ts";
import { blobDir } from "../src/spill.ts";

const BIG = (tag: string) => `${tag} `.repeat(20_000); // > 32k chars default spill threshold

function host(sessionFile: string, branch: any[], all: any[]) {
	const handlers: Record<string, any> = {};
	const tools: Record<string, any> = {};
	const appended: any[] = [];
	sliceofpi({
		on: (n: string, h: any) => { handlers[n] = h; },
		registerTool: (d: any) => { tools[d.name] = d; },
		registerCommand: () => {}, registerFlag: () => {}, sendMessage: () => {}, sendUserMessage: () => {},
		appendEntry: (t: string, d: unknown) => appended.push({ type: "custom", customType: t, data: d }),
	} as any);
	const ctx: any = {
		cwd: mkdtempSync(join(tmpdir(), "cwd-")),
		ui: { notify() {}, setStatus() {}, setWidget() {} },
		sessionManager: { getSessionFile: () => sessionFile, getBranchEntries: () => branch, getEntries: () => all },
		getContextUsage: () => undefined, compact() {}, isIdle: () => true,
	};
	return {
		ctx, appended,
		start: () => handlers.session_start({}, ctx),
		result: (id: string, text: string) => handlers.tool_result({ toolCallId: id, toolName: "bash", isError: false, content: [{ type: "text", text }] }, ctx),
		settle: () => handlers.agent_settled({}, ctx),
		recall: async (ref: string) => (await tools.recall.execute("x", { ref }, undefined, undefined, ctx)).content[0].text as string,
	};
}

test("branch B reusing t1 neither overwrites A's blob nor GC deletes it", async () => {
	const sf = join(mkdtempSync(join(tmpdir(), "sess-")), "s.jsonl");
	const A = host(sf, [], []);
	await A.start(); await A.result("callA", BIG("alpha")); await A.settle();
	const snapA = A.appended.at(-1); expect(snapA.customType).toBe(ENTRY_TYPE);

	// Branch B forked before A's output: its own state starts empty and also mints t1.
	const B = host(sf, [], [snapA]);
	await B.start(); await B.result("callB", BIG("bravo")); await B.settle();
	const snapB = B.appended.at(-1);
	expect(snapB.data.records[0].ref).toBe(snapA.data.records[0].ref); // same ref "t1" on both branches

	// age every blob past the 7-day GC cutoff
	const old = new Date(Date.now() - 10 * 86400000);
	for (const f of readdirSync(blobDir(sf))) utimesSync(join(blobDir(sf), f), old, old);

	// Reopen branch B (active branch = B only, entries = both branches): runs GC.
	const B2 = host(sf, [snapB], [snapA, snapB]);
	await B2.start();
	expect(await B2.recall("t1")).toContain("bravo");

	// Switch back to branch A: its t1 must still be A's output.
	const A2 = host(sf, [snapA], [snapA, snapB]);
	await A2.start();
	const text = await A2.recall("t1");
	expect(text).toContain("alpha");
	expect(text).not.toContain("bravo");
});

test("GC on branch B (distinct refs) keeps A's old blob recallable", async () => {
	const sf = join(mkdtempSync(join(tmpdir(), "sess-")), "s.jsonl");
	const A = host(sf, [], []);
	await A.start(); await A.result("callA", BIG("alpha")); await A.settle();
	const snapA = A.appended.at(-1);
	const old = new Date(Date.now() - 10 * 86400000);
	for (const f of readdirSync(blobDir(sf))) utimesSync(join(blobDir(sf), f), old, old);
	// branch B has its own index (nextRef 5, no t1) so refs do not collide; opening it runs GC
	const snapB = { type: "custom", customType: ENTRY_TYPE, data: { nextRef: 5, records: [], turn: 0 } };
	const B = host(sf, [snapB], [snapA, snapB]);
	await B.start();
	const A2 = host(sf, [snapA], [snapA, snapB]);
	await A2.start();
	expect(await A2.recall("t1")).toContain("alpha");
});
