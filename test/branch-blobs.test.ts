import { test, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentHash, liveBlobKeys, ENTRY_TYPE } from "../src/state.ts";
import { spill, readSpill, gcBlobs, blobDir } from "../src/spill.ts";

const sess = () => join(mkdtempSync(join(tmpdir(), "s-")), "sess.jsonl");
const old = () => new Date(Date.now() - 10 * 86400000);

test("GC with all-branch live keys keeps another branch's old blob", async () => {
	const sf = sess();
	const h = contentHash("branch A big output");
	await spill(sf, h, "branch A big output");
	utimesSync(join(blobDir(sf), `${h}.txt`), old(), old());
	const entries = [{ type: "custom", customType: ENTRY_TYPE, data: { nextRef: 2, turn: 0, records: [{ ref: "t1", hash: h }] } }];
	gcBlobs(sf, liveBlobKeys(entries));
	expect(existsSync(join(blobDir(sf), `${h}.txt`))).toBe(true);
	gcBlobs(sf, new Set()); // truly orphaned: removed
	expect(existsSync(join(blobDir(sf), `${h}.txt`))).toBe(false);
});

test("legacy ref-keyed blob is still readable and kept by GC", () => {
	const sf = sess();
	mkdirSync(blobDir(sf), { recursive: true });
	writeFileSync(join(blobDir(sf), "t1.txt"), "legacy");
	const lh = contentHash("legacy");
	utimesSync(join(blobDir(sf), "t1.txt"), old(), old());
	const entries = [{ type: "custom", customType: ENTRY_TYPE, data: { records: [{ ref: "t1", hash: lh }] } }];
	expect(readSpill(sf, lh, 1000, "t1").text).toBe("legacy");
	gcBlobs(sf, liveBlobKeys(entries));
	expect(existsSync(join(blobDir(sf), "t1.txt"))).toBe(true);
});

test("legacy fallback fails closed when blob content contradicts the recorded hash", () => {
	const sf = sess();
	mkdirSync(blobDir(sf), { recursive: true });
	writeFileSync(join(blobDir(sf), "t1.txt"), "other branch output"); // clobbered
	expect(() => readSpill(sf, contentHash("my original output"), 1000, "t1")).toThrow(/does not match/);
});
