/**
 * BM25 free-text search over session messages, for the recall tool.
 * Design adapted from pi-blackhole (MIT,
 * https://github.com/k0valik/pi-blackhole — src/core/search-entries.ts);
 * implementation is fresh and self-contained.
 */

export interface SearchDoc {
	id: string; // ref or entry id
	label: string; // e.g. "t12 (bash, turn 4)"
	text: string;
}

export interface SearchHit {
	id: string;
	label: string;
	score: number;
	excerpt: string;
}

const K1 = 1.4;
const B = 0.75;

function tokenize(text: string): string[] {
	return text.toLowerCase().split(/[^a-z0-9_./-]+/).filter((t) => t.length > 1);
}

export function bm25Search(docs: SearchDoc[], query: string, limit = 5): SearchHit[] {
	const qTerms = [...new Set(tokenize(query))];
	if (qTerms.length === 0 || docs.length === 0) return [];

	const tokenized = docs.map((d) => tokenize(d.text));
	const avgLen = tokenized.reduce((a, t) => a + t.length, 0) / docs.length || 1;
	const df = new Map<string, number>();
	const tfs = tokenized.map((tokens) => {
		const tf = new Map<string, number>();
		for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
		for (const term of new Set(tokens)) if (qTerms.includes(term)) df.set(term, (df.get(term) ?? 0) + 1);
		return tf;
	});

	const hits: SearchHit[] = [];
	for (let i = 0; i < docs.length; i++) {
		let score = 0;
		const len = tokenized[i]!.length || 1;
		for (const term of qTerms) {
			const f = tfs[i]!.get(term) ?? 0;
			if (f === 0) continue;
			const n = df.get(term) ?? 0;
			const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
			score += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * len) / avgLen));
		}
		if (score > 0) hits.push({ id: docs[i]!.id, label: docs[i]!.label, score, excerpt: excerpt(docs[i]!.text, qTerms) });
	}
	return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

function excerpt(text: string, qTerms: string[], width = 240): string {
	const lower = text.toLowerCase();
	let pos = -1;
	for (const t of qTerms) {
		const p = lower.indexOf(t);
		if (p >= 0 && (pos === -1 || p < pos)) pos = p;
	}
	if (pos === -1) return text.slice(0, width);
	const start = Math.max(0, pos - Math.floor(width / 3));
	return (start > 0 ? "…" : "") + text.slice(start, start + width) + (start + width < text.length ? "…" : "");
}
