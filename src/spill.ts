/**
 * Eager sidecar spill of oversized tool outputs — zero LLM cost.
 * Adapted from pi-condense (MIT, https://github.com/jjuraszek/pi-condense —
 * src/spill.ts): blobs live next to the session file so they share its
 * lifecycle.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export function blobDir(sessionFile: string): string {
	const id = basename(sessionFile).replace(/\.jsonl$/, "");
	return join(dirname(sessionFile), `${id}-blobs`);
}

export function spill(sessionFile: string, ref: string, text: string): string {
	const dir = blobDir(sessionFile);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${ref}.txt`);
	writeFileSync(path, text, "utf8");
	return path;
}

export function readSpill(path: string, maxChars = 60_000): { text: string; truncated: boolean } {
	const full = readFileSync(path, "utf8");
	if (full.length <= maxChars) return { text: full, truncated: false };
	return { text: full.slice(0, maxChars), truncated: true };
}
