import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC_ROOT = join(__dirname, "..", "..", "src");

const VAULT_WRITE_RE =
	/\bapp\.vault\.(modify|create|createFolder|append)\s*\(/;

const TOKEN_REFERENCE_RE = /\b(access_token|refresh_token|stored?Token|bearer)\b/i;

// Build-time invariant from plan task 13: "fails CI if any plugin code path
// writes a token-shaped string to the vault." We detect *suspicious adjacency*
// — a vault-write call and a token reference inside the same function body —
// and fail the test if any source file matches both within the same logical
// block. False positives are explicitly ignored when guarded by the
// `// SAFE-TOKEN-WRITE: <reason>` line comment.

interface Hit {
	file: string;
	function: string;
	preview: string;
}

describe("no-token-vault-write invariant", () => {
	it("never pairs a vault-write API call with a token reference", () => {
		const files = listTsFiles(SRC_ROOT);
		const hits: Hit[] = [];
		for (const file of files) {
			const text = readFileSync(file, "utf8");
			const blocks = splitFunctionBlocks(text);
			for (const block of blocks) {
				if (block.text.includes("SAFE-TOKEN-WRITE")) continue;
				if (
					VAULT_WRITE_RE.test(block.text) &&
					TOKEN_REFERENCE_RE.test(block.text)
				) {
					hits.push({
						file,
						function: block.name,
						preview: block.text.slice(0, 200),
					});
				}
			}
		}
		expect(hits, formatHits(hits)).toEqual([]);
	});
});

function listTsFiles(root: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(root)) {
		const full = join(root, name);
		const s = statSync(full);
		if (s.isDirectory()) out.push(...listTsFiles(full));
		else if (name.endsWith(".ts")) out.push(full);
	}
	return out;
}

interface Block {
	name: string;
	text: string;
}

// Naive function-block splitter: scans for `function`/`async function`/method
// declarations and accumulates lines until the brace count returns to zero.
// Good enough for the plugin's hand-written code; not a TS parser.
function splitFunctionBlocks(text: string): Block[] {
	const blocks: Block[] = [];
	const lines = text.split("\n");
	let i = 0;
	let unnamedCounter = 0;
	while (i < lines.length) {
		const line = lines[i]!;
		const open = line.indexOf("{");
		if (open >= 0 && /\b(function|=>|\)\s*:\s*[A-Za-z<])/.test(line)) {
			const name = extractBlockName(line) ?? `anon-${unnamedCounter++}`;
			let depth = 0;
			const start = i;
			for (let j = i; j < lines.length; j++) {
				const l = lines[j]!;
				for (const c of l) {
					if (c === "{") depth++;
					else if (c === "}") depth--;
				}
				if (depth === 0 && j > i) {
					blocks.push({
						name,
						text: lines.slice(start, j + 1).join("\n"),
					});
					i = j;
					break;
				}
			}
		}
		i++;
	}
	if (blocks.length === 0) {
		// fall back to whole-file as one block so simple modules still get
		// scanned.
		blocks.push({ name: "<file>", text });
	}
	return blocks;
}

function extractBlockName(line: string): string | null {
	const fn = line.match(/function\s+([A-Za-z0-9_$]+)/);
	if (fn) return fn[1] ?? null;
	const method = line.match(/(?:async\s+)?([A-Za-z0-9_$]+)\s*\(/);
	if (method) return method[1] ?? null;
	return null;
}

function formatHits(hits: Hit[]): string {
	if (hits.length === 0) return "no hits";
	return hits
		.map(
			(h) =>
				`Token reference adjacent to vault-write in ${h.file}::${h.function}\nPreview:\n${h.preview}`,
		)
		.join("\n\n");
}
