/**
 * L3 — deterministic compaction render: a structured summary compiled from
 * the session itself with ZERO LLM calls (every summarizer call on Pokee is
 * un-cached full price). Handed to Pi via session_before_compact, which this
 * extension owns exclusively.
 *
 * Structural-summary design adapted from pi-blackhole (MIT,
 * https://github.com/k0valik/pi-blackhole — src/core/summarize.ts compile()).
 * Summary section layout follows Pi core's compaction format
 * (docs/compaction.md) so downstream tooling sees a familiar shape.
 */

import type { AgentMessage } from "./pi-types.ts";
import { resultText } from "./state.ts";

export interface CompiledSummary {
	summary: string;
	readFiles: string[];
	modifiedFiles: string[];
}

const READ_TOOLS = new Set(["read", "grep", "glob"]);
const WRITE_TOOLS = new Set(["write", "edit"]);

export function compileSummary(
	messages: AgentMessage[],
	previous?: { readFiles?: string[]; modifiedFiles?: string[]; summary?: string },
): CompiledSummary {
	const readFiles = new Set(previous?.readFiles ?? []);
	const modifiedFiles = new Set(previous?.modifiedFiles ?? []);
	const commands: string[] = [];
	const userAsks: string[] = [];
	const recentAssistant: string[] = [];

	for (const m of messages) {
		if (m.role === "user" && !m.customType) {
			const text = plainText(m);
			if (text) userAsks.push(truncate(text, 300));
		}
		if (m.role === "assistant" && Array.isArray(m.content)) {
			for (const b of m.content) {
				if (b.type === "toolCall") {
					const call = b as unknown as { name: string; arguments?: Record<string, unknown> };
					const path = typeof call.arguments?.path === "string" ? call.arguments.path : undefined;
					if (path && READ_TOOLS.has(call.name)) readFiles.add(path);
					if (path && WRITE_TOOLS.has(call.name)) modifiedFiles.add(path);
					if (call.name === "bash" && typeof call.arguments?.command === "string")
						commands.push(truncate(call.arguments.command, 160));
				}
				if (b.type === "text") {
					const text = (b as { text: string }).text.trim();
					if (text) recentAssistant.push(text);
				}
			}
		}
	}

	const lines: string[] = [];
	lines.push("## Goal");
	lines.push(userAsks[0] ?? "(no user goal captured)");
	if (previous?.summary) {
		lines.push("", "## Carried context (previous compaction)");
		lines.push(truncate(previous.summary, 2_000));
	}
	if (userAsks.length > 1) {
		lines.push("", "## User requests in this span");
		for (const ask of userAsks.slice(1).slice(-10)) lines.push(`- ${ask}`);
	}
	if (commands.length > 0) {
		lines.push("", "## Commands run");
		for (const cmd of dedupeTail(commands, 15)) lines.push(`- \`${cmd}\``);
	}
	if (recentAssistant.length > 0) {
		lines.push("", "## Recent progress (assistant, newest last)");
		for (const t of recentAssistant.slice(-3)) lines.push(truncate(t, 500));
	}
	lines.push("", "<read-files>", ...[...readFiles].sort(), "</read-files>");
	lines.push("", "<modified-files>", ...[...modifiedFiles].sort(), "</modified-files>");

	return { summary: lines.join("\n"), readFiles: [...readFiles].sort(), modifiedFiles: [...modifiedFiles].sort() };
}

function plainText(m: AgentMessage): string {
	if (typeof m.content === "string") return m.content.trim();
	if (!Array.isArray(m.content)) return "";
	return m.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text")
		.map((b) => b.text.trim())
		.join("\n");
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function dedupeTail(items: string[], keep: number): string[] {
	return [...new Set(items)].slice(-keep);
}

/** Serialize a span for an optional LLM polish pass (background, bounded). */
export function serializeSpan(messages: AgentMessage[], maxCharsPerResult = 2_000): string {
	const out: string[] = [];
	for (const m of messages) {
		if (m.role === "user" && !m.customType) out.push(`[User]: ${plainText(m)}`);
		else if (m.role === "assistant") {
			const text = plainText(m);
			if (text) out.push(`[Assistant]: ${text}`);
		} else if (m.role === "toolResult") {
			const text = resultText(m);
			out.push(`[Tool result]: ${text.length > maxCharsPerResult ? `${text.slice(0, maxCharsPerResult)}… (${text.length - maxCharsPerResult} chars truncated)` : text}`);
		}
	}
	return out.join("\n");
}
