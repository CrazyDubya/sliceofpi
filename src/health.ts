/**
 * Cheap per-turn model-health score in [0,1] (1 = healthy). Feeds the
 * health-adaptive threshold (config.resolveTier): compact earlier when the
 * model shows long-context degradation.
 *
 * Scoring dimensions adapted from pi-mega-compact (BSD-3-Clause,
 * https://github.com/TheArchitectit/pi-mega-compact — src/contextHealth/):
 * output repetition + error escalation + topic drift. Cache-poison scoring is
 * deliberately omitted (no prompt cache on Pokee-Isaac). Implementation is
 * fresh and dependency-free.
 */

export class HealthTracker {
	private errorRing: boolean[] = [];
	private textRing: string[] = [];
	private readonly ringSize = 5;

	noteToolResult(isError: boolean): void {
		this.errorRing.push(isError);
		if (this.errorRing.length > this.ringSize * 4) this.errorRing.shift();
	}

	noteAssistantText(text: string): void {
		if (!text) return;
		this.textRing.push(text);
		if (this.textRing.length > this.ringSize) this.textRing.shift();
	}

	/** 1 = healthy. Combines repetition, recent error rate, and stuckness drift. */
	score(): number {
		const rep = this.repetition();
		const err = this.errorRate();
		const drift = this.drift();
		return Math.max(0, Math.min(1, 1 - 0.5 * rep - 0.3 * err - 0.2 * drift));
	}

	/**
	 * "Stuckness" drift: mean pairwise trigram overlap across the whole recent
	 * output ring. High values mean successive outputs keep circling the same
	 * ground — the long-context failure mode of a model that has stopped
	 * making progress — distinct from repetition(), which only compares the
	 * newest output against history.
	 */
	private drift(): number {
		if (this.textRing.length < 3) return 0;
		const grams = this.textRing.map((t) => trigrams(t));
		let sum = 0;
		let pairs = 0;
		for (let i = 0; i < grams.length; i++)
			for (let j = i + 1; j < grams.length; j++) {
				sum += jaccard(grams[i]!, grams[j]!);
				pairs++;
			}
		return pairs === 0 ? 0 : sum / pairs;
	}

	/** Fraction of trigrams in the newest output already seen in prior outputs. */
	private repetition(): number {
		if (this.textRing.length < 2) return 0;
		const latest = trigrams(this.textRing[this.textRing.length - 1]!);
		if (latest.size === 0) return 0;
		const prior = new Set<string>();
		for (let i = 0; i < this.textRing.length - 1; i++) for (const g of trigrams(this.textRing[i]!)) prior.add(g);
		let hits = 0;
		for (const g of latest) if (prior.has(g)) hits++;
		return hits / latest.size;
	}

	private errorRate(): number {
		if (this.errorRing.length === 0) return 0;
		const recent = this.errorRing.slice(-10);
		return recent.filter(Boolean).length / recent.length;
	}
}

function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let inter = 0;
	for (const g of a) if (b.has(g)) inter++;
	return inter / (a.size + b.size - inter);
}

function trigrams(text: string): Set<string> {
	const words = text.toLowerCase().split(/\s+/).filter(Boolean);
	const grams = new Set<string>();
	for (let i = 0; i + 2 < words.length; i++) grams.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
	return grams;
}
