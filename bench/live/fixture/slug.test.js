import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify } from "./slug.js";

test("lowercases and hyphenates", () => {
	assert.equal(slugify("Hello World"), "hello-world");
});

test("strips punctuation and collapses separators", () => {
	assert.equal(slugify("A -- b!! c??"), "a-b-c");
});

test("trims leading/trailing separators", () => {
	assert.equal(slugify("  --Hello--  "), "hello");
});

test("keeps digits", () => {
	assert.equal(slugify("Top 10 things"), "top-10-things");
});
