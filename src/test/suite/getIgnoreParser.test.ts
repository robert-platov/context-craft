import * as assert from "assert";
import * as path from "path";
import * as os from "os";
import * as fs from "fs/promises";
import proxyquire = require("proxyquire");
import type * as vscode from "vscode";
import { createMockUri, createVsCodeMock } from "../mocks";
import ignore from "ignore";

const proxyquireNoCallThru = proxyquire.noCallThru();
const ignoreParserCache = new Map<string, { parser: ReturnType<typeof ignore>; mtime: number }>();
const vscodeMock = createVsCodeMock();
const { getIgnoreParser, DEFAULT_IGNORE_PATTERNS } = proxyquireNoCallThru("../../getIgnoreParser", {
	vscode: vscodeMock,
	"./extension": { ignoreParserCache }
}) as typeof import("../../getIgnoreParser");

suite("getIgnoreParser", () => {
	let tempRoot: string;
	let gitignoreFile: string;
	const toUri = (target: string): vscode.Uri => createMockUri(target);

	suiteSetup(async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "context-craft-"));
	});

	suiteTeardown(async () => {
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	setup(async () => {
		ignoreParserCache.clear();
		await fs.rm(tempRoot, { recursive: true, force: true });
		await fs.mkdir(tempRoot, { recursive: true });
		gitignoreFile = path.join(tempRoot, ".gitignore");
	});

	teardown(async () => {
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	test("caches parser and refreshes when .gitignore changes", async function () {
		this.timeout(3000);
		await fs.writeFile(gitignoreFile, "*.log\n");
		
		const parser1 = await getIgnoreParser(toUri(tempRoot));
		const parser2 = await getIgnoreParser(toUri(tempRoot));
		
		assert.strictEqual(parser1, parser2, "should return cached parser for same mtime");
		
		await fs.writeFile(gitignoreFile, "*.log\n*.tmp\n");
		const nowSeconds = Date.now() / 1000;
		await fs.utimes(gitignoreFile, nowSeconds, nowSeconds + 1);
		
		const parser3 = await getIgnoreParser(toUri(tempRoot));
		
		assert.notStrictEqual(parser1, parser3, "should return new parser after file change");
		assert.ok(parser3.ignores("test.tmp"), "new parser should include updated rules");
	});

	test("DEFAULT_IGNORE_PATTERNS includes .git", () => {
		assert.ok(DEFAULT_IGNORE_PATTERNS.includes(".git"), "should include .git");
		assert.ok(DEFAULT_IGNORE_PATTERNS.includes(".git/"), "should include .git/");
	});

	test("always ignores .git even with .gitignore file", async function () {
		this.timeout(3000);
		await fs.writeFile(gitignoreFile, "*.log\n");
		
		const parser = await getIgnoreParser(toUri(tempRoot));
		
		assert.ok(parser.ignores(".git"), "should ignore .git");
		assert.ok(parser.ignores(".git/"), "should ignore .git/");
		assert.ok(parser.ignores(".git/config"), "should ignore files inside .git");
	});

	test("always ignores .git even without .gitignore file", async function () {
		this.timeout(3000);
		// No .gitignore file exists
		
		const parser = await getIgnoreParser(toUri(tempRoot));
		
		assert.ok(parser.ignores(".git"), "should ignore .git");
		assert.ok(parser.ignores(".git/"), "should ignore .git/");
		assert.ok(parser.ignores(".git/config"), "should ignore files inside .git");
	});
}); 
