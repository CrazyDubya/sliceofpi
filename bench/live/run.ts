/**
 * Live A/B pilot: runs scripted episodes through real `pi --mode rpc` against
 * Pokee-Isaac, arm A (stock Pi) vs arm B (sliceofpi loaded via -e).
 * Programmatic verifiers, per-episode budget guard, results table + JSON.
 *
 * Run: node --experimental-strip-types bench/live/run.ts [--arms a,b] [--tasks t1,t2,t3] [--repeats 1]
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { POKEE_ISAAC_10M } from "../../src/config.ts";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const PI_BIN = "/opt/homebrew/bin/pi";
const PRICE_IN = POKEE_ISAAC_10M.priceInPerM / 1e6;
const PRICE_OUT = POKEE_ISAAC_10M.priceOutPerM / 1e6;
const EPISODE_BUDGET_USD = 1.4;
const GLOBAL_BUDGET_USD = 1.85;
const PROMPT_TIMEOUT_MS = 300_000;

interface Task {
	id: string;
	prompts: string[];
	verify: (workdir: string) => boolean;
	kind: "parity" | "longtail";
}

const TASKS: Task[] = [
	{
		id: "t1-median",
		kind: "parity",
		prompts: [
			"Run `node --test mathx.test.js` in this directory, then fix the bug in mathx.js so all tests pass. Do NOT modify mathx.test.js. Re-run the tests to confirm.",
		],
		verify: (wd) => spawnSync("node", ["--test", "mathx.test.js"], { cwd: wd }).status === 0,
	},
	{
		id: "t2-slugify",
		kind: "parity",
		prompts: [
			"Implement slugify in slug.js so `node --test slug.test.js` passes. Do NOT modify slug.test.js. Run the tests to confirm.",
		],
		verify: (wd) => spawnSync("node", ["--test", "slug.test.js"], { cwd: wd }).status === 0,
	},
	{
		id: "t5-bigtail",
		kind: "longtail",
		prompts: [
			"Run `node gen-logs.js 2 > run1.log && node gen-logs.js 2 > run2.log && node gen-logs.js 2 > run3.log`. Then read run1.log IN FULL (page through the whole file with the read tool) and summarize the deploy in one paragraph.",
			"Read run2.log in full the same way and report its line count and the time range covered.",
			"Read run3.log in full the same way and report how many 'rolling restart' events it contains.",
			"Run `node -e \"console.log(6*7)\"` and tell me the result.",
			"What is the capital of France? One word answer.",
			"Run `node -e \"console.log(process.version)\"` and report the version.",
			"List the files in this directory with `ls -la` and tell me how many there are.",
			"What does HTTP status 418 mean? One sentence.",
			"From run1.log which you read earlier: write the exact value of deploy_key_fingerprint (just the value) to answer.txt.",
			"Fix the bug in mathx.js so `node --test mathx.test.js` passes without modifying the test file, and re-run the tests to confirm.",
		],
		verify: (wd) => {
			let ok = true;
			try {
				ok = readFileSync(join(wd, "answer.txt"), "utf8").includes("XJ4-QQ7-ZZ9-PK2");
			} catch {
				ok = false;
			}
			return ok && spawnSync("node", ["--test", "mathx.test.js"], { cwd: wd }).status === 0;
		},
	},
	{
		id: "t4-fattail",
		kind: "longtail",
		prompts: [
			"Run `node gen-logs.js > run1.log 2>&1` then read run1.log fully (page through all of it) and summarize the deploy in one paragraph.",
			"Run `node gen-logs.js > run2.log` and `cat run1.log run2.log | sort > merged.log`, then read merged.log and tell me the total line count and time range covered.",
			"Read mathx.js, mathx.test.js, slug.js, and slug.test.js in full and describe each file's purpose in one line.",
			"Run `node -e \"console.log(6*7)\"` and tell me the result.",
			"What is the capital of France? One word answer.",
			"Run `node -e \"console.log(process.version)\"` and report the version.",
			"List the files in this directory with `ls -la` and tell me how many there are.",
			"Run `node -e \"console.log([3,1,2].sort())\"` and report the output.",
			"What does HTTP status 418 mean? One sentence.",
			"Run `date` and tell me the weekday.",
			"Run `node -e \"console.log('ok')\"` and confirm it printed ok.",
			"From the deploy log you reviewed at the start: write the exact value of deploy_key_fingerprint (just the value) to answer.txt.",
			"Fix the bug in mathx.js so `node --test mathx.test.js` passes without modifying the test file, and re-run the tests to confirm.",
		],
		verify: (wd) => {
			let ok = true;
			try {
				ok = readFileSync(join(wd, "answer.txt"), "utf8").includes("XJ4-QQ7-ZZ9-PK2");
			} catch {
				ok = false;
			}
			return ok && spawnSync("node", ["--test", "mathx.test.js"], { cwd: wd }).status === 0;
		},
	},
	{
		id: "t3-longtail",
		kind: "longtail",
		prompts: [
			"Run `node gen-logs.js` and review the deploy log output. Give me a one-paragraph summary of what the deploy did.",
			"Now read mathx.js and slug.js and briefly describe what each file provides.",
			"Run `node --test mathx.test.js` and report how many tests pass and fail.",
			"From the deploy log output you saw earlier: write the exact value of deploy_key_fingerprint (just the value) to a file named answer.txt in this directory.",
		],
		verify: (wd) => {
			try {
				return readFileSync(join(wd, "answer.txt"), "utf8").includes("XJ4-QQ7-ZZ9-PK2");
			} catch {
				return false;
			}
		},
	},
];

interface EpisodeResult {
	task: string;
	kind: string;
	arm: string;
	repeat: number;
	success: boolean;
	usd: number;
	inputTokens: number;
	outputTokens: number;
	turns: number;
	seconds: number;
	overBudget: boolean;
	aborts: number;
	perPrompt: { prompt: number; inputDelta: number; usd: number }[];
	error?: string;
}

class Rpc {
	private buf = "";
	private waiters: { match: (o: any) => boolean; resolve: (o: any) => void }[] = [];
	readonly proc: ChildProcessWithoutNullStreams;
	events: { type: string }[] = [];

	constructor(args: string[], cwd: string) {
		this.proc = spawn(PI_BIN, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
		this.proc.stdout.on("data", (chunk: Buffer) => {
			this.buf += chunk.toString("utf8");
			let nl: number;
			while ((nl = this.buf.indexOf("\n")) >= 0) {
				const line = this.buf.slice(0, nl).replace(/\r$/, "");
				this.buf = this.buf.slice(nl + 1);
				if (!line.trim()) continue;
				let obj: any;
				try {
					obj = JSON.parse(line);
				} catch {
					continue;
				}
				if (obj?.type) this.events.push({ type: obj.type });
				for (let i = 0; i < this.waiters.length; i++) {
					if (this.waiters[i]!.match(obj)) {
						const [w] = this.waiters.splice(i, 1);
						w!.resolve(obj);
						break;
					}
				}
			}
		});
	}

	send(cmd: object): void {
		this.proc.stdin.write(`${JSON.stringify(cmd)}\n`);
	}

	waitFor(match: (o: any) => boolean, timeoutMs: number): Promise<any> {
		return new Promise((res, rej) => {
			const t = setTimeout(() => rej(new Error("rpc timeout")), timeoutMs);
			this.waiters.push({
				match,
				resolve: (o) => {
					clearTimeout(t);
					res(o);
				},
			});
		});
	}

	kill(): void {
		try {
			this.proc.kill("SIGTERM");
		} catch {}
	}
}

async function runEpisode(task: Task, arm: "a" | "b", repeat: number, outDir: string): Promise<EpisodeResult> {
	const workdir = mkdtempSync(join(tmpdir(), `slice-ab-${task.id}-${arm}-`));
	cpSync(join(HERE, "fixture"), workdir, { recursive: true });
	const sessionDir = join(outDir, "sessions", `${task.id}-${arm}-${repeat}`);
	mkdirSync(sessionDir, { recursive: true });

	const args = ["--mode", "rpc", "--provider", "pokee", "--model", "pokee-isaac", "--session-dir", sessionDir];
	if (arm === "b") args.push("-e", join(REPO, "src/index.ts"));

	const rpc = new Rpc(args, workdir);
	const started = Date.now();
	let stderr = "";
	rpc.proc.stderr.on("data", (c: Buffer) => (stderr += c.toString()));

	let usd = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	let overBudget = false;
	let aborts = 0;
	const perPrompt: { prompt: number; inputDelta: number; usd: number }[] = [];
	let error: string | undefined;

	try {
		for (const [i, prompt] of task.prompts.entries()) {
			rpc.send({ id: `p${i}`, type: "prompt", message: prompt });
			const resp = await rpc.waitFor((o) => o.type === "response" && o.id === `p${i}`, 30_000);
			if (!resp.success) throw new Error(`prompt rejected: ${JSON.stringify(resp)}`);
			try {
				await rpc.waitFor((o) => o.type === "agent_settled", PROMPT_TIMEOUT_MS);
			} catch {
				// hung turn (e.g. a model-issued command blocking on stdin):
				// abort the run and carry on with the remaining prompts
				aborts++;
				rpc.send({ type: "abort" });
				await rpc.waitFor((o) => o.type === "agent_settled", 60_000);
			}
			rpc.send({ id: `s${i}`, type: "get_session_stats" });
			const stats = await rpc.waitFor((o) => o.type === "response" && o.id === `s${i}`, 30_000);
			const tok = stats.data?.tokens ?? {};
			const prevIn = inputTokens;
			const prevUsd = usd;
			inputTokens = (tok.input ?? 0) + (tok.cacheRead ?? 0) + (tok.cacheWrite ?? 0);
			outputTokens = tok.output ?? 0;
			usd = inputTokens * PRICE_IN + outputTokens * PRICE_OUT;
			perPrompt.push({ prompt: i, inputDelta: inputTokens - prevIn, usd: usd - prevUsd });
			if (usd > EPISODE_BUDGET_USD) {
				overBudget = true;
				break;
			}
		}
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
		if (stderr) error += ` | stderr: ${stderr.slice(-400)}`;
	} finally {
		rpc.kill();
	}

	const turns = rpc.events.filter((e) => e.type === "turn_end").length;
	const success = !error && !overBudget && task.verify(workdir);
	return {
		task: task.id,
		kind: task.kind,
		arm,
		repeat,
		success,
		usd,
		inputTokens,
		outputTokens,
		turns,
		seconds: Math.round((Date.now() - started) / 1000),
		overBudget,
		aborts,
		perPrompt,
		error,
	};
}

// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const opt = (name: string, dflt: string) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1]! : dflt;
};
const arms = opt("arms", "a,b").split(",") as ("a" | "b")[];
const taskIds = opt("tasks", TASKS.map((t) => t.id).join(",")).split(",");
const repeats = Number(opt("repeats", "1"));

if (!existsSync(PI_BIN)) {
	console.error(`pi binary not found at ${PI_BIN}`);
	process.exit(1);
}

const outDir = join(HERE, "results");
mkdirSync(outDir, { recursive: true });

const results: EpisodeResult[] = [];
let globalSpend = 0;
outer: for (let r = 0; r < repeats; r++) {
	for (const task of TASKS.filter((t) => taskIds.includes(t.id))) {
		for (const arm of arms) {
			if (globalSpend >= GLOBAL_BUDGET_USD) {
				console.log(`global budget \$${GLOBAL_BUDGET_USD} reached; stopping`);
				break outer;
			}
			process.stdout.write(`running ${task.id} arm=${arm} repeat=${r} ... `);
			const res = await runEpisode(task, arm, r, outDir);
			results.push(res);
			globalSpend += res.usd;
			console.log(
				res.error
					? `ERROR (${res.error.slice(0, 120)})`
					: `${res.success ? "PASS" : "FAIL"} $${res.usd.toFixed(3)} in=${res.inputTokens} out=${res.outputTokens} turns=${res.turns} ${res.seconds}s${res.overBudget ? " OVER-BUDGET" : ""}`,
			);
		}
	}
}

console.log("\ntask         | arm | ok  | $      | input tok | turns | s");
console.log("-------------|-----|-----|--------|-----------|-------|----");
for (const r of results)
	console.log(
		`${r.task.padEnd(12)} | ${r.arm.padEnd(3)} | ${(r.error ? "ERR" : r.success ? "yes" : "no").padEnd(3)} | $${r.usd.toFixed(3)} | ${String(r.inputTokens).padStart(9)} | ${String(r.turns).padStart(5)} | ${r.seconds}`,
	);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
writeFileSync(join(outDir, `pilot-${stamp}.json`), JSON.stringify(results, null, 2));
console.log(`\nsaved bench/live/results/pilot-${stamp}.json`);
const spend = results.reduce((a, r) => a + r.usd, 0);
console.log(`total spend: $${spend.toFixed(3)}`);
