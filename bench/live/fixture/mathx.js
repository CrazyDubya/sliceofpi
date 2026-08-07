// Small stats helpers used by the pilot tasks.

export function mean(xs) {
	if (xs.length === 0) return NaN;
	return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// BUG (task1 target): median must not assume input is sorted, and must not
// mutate the caller's array.
export function median(xs) {
	if (xs.length === 0) return NaN;
	const mid = Math.floor(xs.length / 2);
	return xs.length % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}
