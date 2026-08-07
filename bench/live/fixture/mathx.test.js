import { test } from "node:test";
import assert from "node:assert/strict";
import { mean, median } from "./mathx.js";

test("mean", () => {
	assert.equal(mean([1, 2, 3]), 2);
});

test("median of unsorted odd list", () => {
	assert.equal(median([9, 1, 5]), 5);
});

test("median of unsorted even list", () => {
	assert.equal(median([7, 1, 3, 9]), 5);
});

test("median does not mutate input", () => {
	const xs = [3, 1, 2];
	median(xs);
	assert.deepEqual(xs, [3, 1, 2]);
});
