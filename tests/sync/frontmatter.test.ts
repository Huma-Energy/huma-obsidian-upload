import { describe, expect, it } from "vitest";
import {
	HUMA_UUID_KEY,
	parseFile,
	readHumaUuid,
	stringifyFile,
	withHumaUuid,
} from "../../src/sync/frontmatter";
import { sha256Hex } from "../../src/sync/hash";

describe("frontmatter", () => {
	it("round-trips a file with frontmatter without changing the body hash", async () => {
		const original = `---\ntitle: Test\ntags:\n  - alpha\n---\n\nBody text.\n`;
		const parsed = parseFile(original);
		const reemitted = stringifyFile(parsed.body, parsed.frontmatter);
		const reparsed = parseFile(reemitted);
		const h1 = await sha256Hex(parsed.body);
		const h2 = await sha256Hex(reparsed.body);
		expect(h1).toBe(h2);
	});

	it("returns the full text as body for files without frontmatter", () => {
		const text = "# Heading\n\nBody only.\n";
		const parsed = parseFile(text);
		expect(parsed.frontmatter).toEqual({});
		expect(parsed.body).toBe(text);
	});

	it("does not emit an empty YAML block when frontmatter is {}", () => {
		const out = stringifyFile("Hello\n", {});
		expect(out).toBe("Hello\n");
	});

	it("preserves user keys when adding huma_uuid", () => {
		const fm = { title: "Doc", tags: ["a"] };
		const next = withHumaUuid(fm, "uuid-1");
		expect(Object.keys(next)).toEqual(["title", "tags", HUMA_UUID_KEY]);
		expect(next[HUMA_UUID_KEY]).toBe("uuid-1");
		expect(fm).toEqual({ title: "Doc", tags: ["a"] });
	});

	it("replaces an existing huma_uuid in place rather than duplicating", () => {
		const fm = { title: "Doc", huma_uuid: "old", tags: ["a"] };
		const next = withHumaUuid(fm, "new");
		expect(Object.keys(next)).toEqual(["title", "tags", HUMA_UUID_KEY]);
		expect(next[HUMA_UUID_KEY]).toBe("new");
	});

	it("readHumaUuid returns null when absent or non-string", () => {
		expect(readHumaUuid({})).toBeNull();
		expect(readHumaUuid({ huma_uuid: "" })).toBeNull();
		expect(readHumaUuid({ huma_uuid: 42 as unknown as string })).toBeNull();
		expect(readHumaUuid({ huma_uuid: "abc-1" })).toBe("abc-1");
	});

	it("body hash is invariant under huma_uuid injection", async () => {
		const original = `---\ntitle: With UUID\n---\n\nBody body body.\n`;
		const parsed = parseFile(original);
		const h1 = await sha256Hex(parsed.body);
		const injected = stringifyFile(
			parsed.body,
			withHumaUuid(parsed.frontmatter, "uuid-xyz"),
		);
		const reparsed = parseFile(injected);
		const h2 = await sha256Hex(reparsed.body);
		expect(h2).toBe(h1);
		expect(reparsed.frontmatter[HUMA_UUID_KEY]).toBe("uuid-xyz");
	});

	it("hash of parsed-back body is stable across stringify round-trip even when body is empty", async () => {
		// Backfilled web-native docs arrive with body=="" and frontmatter={huma_uuid}.
		// The pull worker must hash what it actually wrote (parseFile(text).body),
		// not the raw server body, otherwise the next scan flags the file as
		// locally-edited every cycle (sha256("") != sha256("\n")).
		const text = stringifyFile("", { huma_uuid: "uuid-empty" });
		const onDiskBody = parseFile(text).body;
		const hashWrite = await sha256Hex(onDiskBody);
		// Simulate the next scan reading the same file content back.
		const hashScan = await sha256Hex(parseFile(text).body);
		expect(hashWrite).toBe(hashScan);
	});
});
