/**
 * Eager sidecar spill of oversized tool outputs — zero LLM cost.
 * Adapted from pi-condense (MIT, https://github.com/jjuraszek/pi-condense —
 * src/spill.ts): blobs live next to the session file so they share its
 * lifecycle.
 *
 * SECURITY: blob paths are always DERIVED from (sessionFile, ref) — never
 * stored, never read from persisted data. A crafted session entry therefore
 * cannot point recall() at an arbitrary file.
 */

import { closeSync, openSync, readSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export function blobDir(sessionFile: string): string {
	const id = basename(sessionFile).replace(/\.jsonl$/, "");
	return join(dirname(sessionFile), `${id}-blobs`);
}

function blobPath(sessionFile: string, ref: string): string {
	return join(blobDir(sessionFile), `${ref}.txt`);
}

/** Async so multi-MB writes never block the event loop mid-turn. */
export async function spill(sessionFile: string, ref: string, text: string): Promise<void> {
	const dir = blobDir(sessionFile);
	await mkdir(dir, { recursive: true });
	await writeFile(blobPath(sessionFile, ref), text, "utf8");
}

/** Reads at most maxChars + 1 bytes — never the whole blob. */
export function readSpill(sessionFile: string, ref: string, maxChars = 60_000): { text: string; truncated: boolean } {
	const fd = openSync(blobPath(sessionFile, ref), "r");
	try {
		const buf = Buffer.alloc(maxChars + 1);
		const bytes = readSync(fd, buf, 0, buf.length, 0);
		const truncated = bytes > maxChars;
		return { text: buf.toString("utf8", 0, Math.min(bytes, maxChars)), truncated };
	} finally {
		closeSync(fd);
	}
}

/**
 * Garbage-collect orphaned blobs: files whose ref is no longer in the live
 * index AND older than maxAgeDays. Referenced blobs are kept forever (they
 * back recall()).
 */
export function gcBlobs(sessionFile: string, liveRefs: Set<string>, maxAgeDays = 7): number {
	const dir = blobDir(sessionFile);
	let removed = 0;
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return 0;
	}
	const cutoff = Date.now() - maxAgeDays * 86_400_000;
	for (const name of names) {
		if (liveRefs.has(name.replace(/\.txt$/, ""))) continue;
		const path = join(dir, name);
		try {
			if (statSync(path).mtimeMs < cutoff) {
				unlinkSync(path);
				removed++;
			}
		} catch {
			// raced with another process; skip
		}
	}
	return removed;
}
