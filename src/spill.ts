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

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { contentHash } from "./state.ts";
import { basename, dirname, join } from "node:path";

export function blobDir(sessionFile: string): string {
	const id = basename(sessionFile).replace(/\.jsonl$/, "");
	return join(dirname(sessionFile), `${id}-blobs`);
}

/**
 * Blobs are keyed by CONTENT HASH, not by tN ref. Refs restart per branch
 * (state is rebuilt from the active branch only) while the blob dir is shared
 * by every branch of the session, so ref-keyed files collide across branches.
 * Identical content shares one file, which is safe by construction.
 */
function blobPath(sessionFile: string, key: string): string {
	return join(blobDir(sessionFile), `${key}.txt`);
}

/** Async so multi-MB writes never block the event loop mid-turn. */
export async function spill(sessionFile: string, ref: string, text: string): Promise<void> {
	const dir = blobDir(sessionFile);
	await mkdir(dir, { recursive: true });
	await writeFile(blobPath(sessionFile, ref), text, "utf8");
}

/** Reads at most maxChars + 1 bytes — never the whole blob. */
export function readSpill(sessionFile: string, key: string, maxChars = 60_000, legacyRef?: string): { text: string; truncated: boolean } {
	let path = blobPath(sessionFile, key);
	if (legacyRef && !existsSync(path)) {
		// Pre-fix sessions wrote <ref>.txt, and the ref may have been clobbered by another branch.
		// The record hash is sha256 of the full spilled text, so verify before trusting it. Fail closed.
		path = blobPath(sessionFile, legacyRef);
		const full = readFileSync(path, "utf8");
		if (contentHash(full) !== key) throw new Error(`legacy blob ${legacyRef} does not match its recorded hash (likely overwritten by another branch); not returning it`);
		return { text: full.slice(0, maxChars), truncated: full.length > maxChars };
	}
	const fd = openSync(path, "r");
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
 * Garbage-collect orphaned blobs: files whose key (content hash, or legacy
 * ref) is not in liveKeys AND older than maxAgeDays. liveKeys MUST cover every
 * branch of the session, not just the active one.
 */
export function gcBlobs(sessionFile: string, liveKeys: Set<string>, maxAgeDays = 7): number {
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
		if (liveKeys.has(name.replace(/\.txt$/, ""))) continue;
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
