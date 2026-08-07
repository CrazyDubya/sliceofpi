// Deterministic noisy deploy log (~160k chars) with a few config facts buried
// mid-stream. Used by the long-tail pilot task.
let a = 42;
const rand = () => {
	a |= 0;
	a = (a + 0x6d2b79f5) | 0;
	let t = Math.imul(a ^ (a >>> 15), 1 | a);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const svcs = ["auth", "billing", "ingest", "search", "notify", "gateway"];
const verbs = ["starting", "healthcheck ok", "scaled to 3 replicas", "connection pool warm", "cache primed", "rolling restart", "draining", "ready"];
const lines = [];
for (let i = 0; i < 2400; i++) {
	const ts = new Date(1754000000000 + i * 733).toISOString();
	lines.push(`${ts} [${svcs[Math.floor(rand() * svcs.length)]}] ${verbs[Math.floor(rand() * verbs.length)]} (pid ${1000 + Math.floor(rand() * 9000)})`);
	if (i === 1187) lines.push(`${ts} [gateway] config loaded: deploy_key_fingerprint=XJ4-QQ7-ZZ9-PK2 rotation=90d`);
	if (i === 1490) lines.push(`${ts} [billing] config loaded: invoice_batch_cursor=b-77021 mode=strict`);
}
console.log(lines.join("\n"));
