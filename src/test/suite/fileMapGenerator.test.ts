import * as assert from "assert";
import * as path from "path";
import { generateFileMap, generateFileMapMultiRoot } from "../../fileMapGenerator";

suite("fileMapGenerator", () => {
	const workspaceRoot = "/Users/test/project";

	test("generateFileMap() returns empty string for empty files array", () => {
		const result = generateFileMap([], workspaceRoot);
		assert.strictEqual(result, "");
	});

	test("generateFileMap() generates correct tree for single file", () => {
		const files = [path.join(workspaceRoot, "index.ts")];
		const result = generateFileMap(files, workspaceRoot);

		assert.ok(result.startsWith("<file_map>"), "should start with <file_map>");
		assert.ok(result.endsWith("</file_map>"), "should end with </file_map>");
		assert.ok(result.includes(workspaceRoot), "should include workspace root");
		assert.ok(result.includes("index.ts *"), "should include file with selection marker");
	});

	test("generateFileMap() generates correct tree for multiple files", () => {
		const files = [
			path.join(workspaceRoot, "src", "index.ts"),
			path.join(workspaceRoot, "src", "utils.ts"),
			path.join(workspaceRoot, "package.json")
		];
		const result = generateFileMap(files, workspaceRoot);

		assert.ok(result.includes("src"), "should include src directory");
		assert.ok(result.includes("index.ts *"), "should include index.ts with marker");
		assert.ok(result.includes("utils.ts *"), "should include utils.ts with marker");
		assert.ok(result.includes("package.json *"), "should include package.json with marker");
	});

	test("generateFileMap() sorts directories before files", () => {
		const files = [
			path.join(workspaceRoot, "README.md"),
			path.join(workspaceRoot, "src", "index.ts")
		];
		const result = generateFileMap(files, workspaceRoot);

		const srcIndex = result.indexOf("src");
		const readmeIndex = result.indexOf("README.md");
		assert.ok(srcIndex < readmeIndex, "src directory should come before README.md file");
	});

	test("generateFileMap() handles nested directories", () => {
		const files = [
			path.join(workspaceRoot, "src", "commands", "copy.ts"),
			path.join(workspaceRoot, "src", "utils.ts")
		];
		const result = generateFileMap(files, workspaceRoot);

		assert.ok(result.includes("commands"), "should include nested commands directory");
		assert.ok(result.includes("copy.ts *"), "should include nested file");
	});

	test("generateFileMap() uses correct tree characters", () => {
		const files = [
			path.join(workspaceRoot, "a.ts"),
			path.join(workspaceRoot, "b.ts")
		];
		const result = generateFileMap(files, workspaceRoot);

		assert.ok(result.includes("├──") || result.includes("└──"), "should use tree connectors");
	});

	test("generateFileMapMultiRoot() returns empty string for empty map", () => {
		const result = generateFileMapMultiRoot(new Map());
		assert.strictEqual(result, "");
	});

	test("generateFileMapMultiRoot() handles multiple workspaces", () => {
		const multiRootMap = new Map([
			["/workspace1", {
				workspaceName: "project1",
				workspacePath: "/workspace1",
				files: ["/workspace1/index.ts"]
			}],
			["/workspace2", {
				workspaceName: "project2",
				workspacePath: "/workspace2",
				files: ["/workspace2/main.ts"]
			}]
		]);

		const result = generateFileMapMultiRoot(multiRootMap);

		assert.ok(result.startsWith("<file_map>"), "should start with <file_map>");
		assert.ok(result.endsWith("</file_map>"), "should end with </file_map>");
		assert.ok(result.includes("/workspace1"), "should include first workspace path");
		assert.ok(result.includes("/workspace2"), "should include second workspace path");
		assert.ok(result.includes("index.ts *"), "should include file from first workspace");
		assert.ok(result.includes("main.ts *"), "should include file from second workspace");
	});

	test("generateFileMapMultiRoot() skips workspaces with no files", () => {
		const multiRootMap = new Map([
			["/workspace1", {
				workspaceName: "project1",
				workspacePath: "/workspace1",
				files: ["/workspace1/index.ts"]
			}],
			["/workspace2", {
				workspaceName: "project2",
				workspacePath: "/workspace2",
				files: []
			}]
		]);

		const result = generateFileMapMultiRoot(multiRootMap);

		assert.ok(result.includes("/workspace1"), "should include first workspace");
		assert.ok(!result.includes("/workspace2"), "should not include empty workspace");
	});

	test("generateFileMap() marks only selected files when selectedFiles provided", () => {
		const allFiles = [
			path.join(workspaceRoot, "src", "index.ts"),
			path.join(workspaceRoot, "src", "utils.ts"),
			path.join(workspaceRoot, "package.json")
		];
		const selectedFiles = [path.join(workspaceRoot, "src", "index.ts")];

		const result = generateFileMap(allFiles, workspaceRoot, selectedFiles);

		assert.ok(result.includes("index.ts *"), "selected file should have marker");
		assert.ok(result.includes("utils.ts") && !result.includes("utils.ts *"), "non-selected file should not have marker");
		assert.ok(result.includes("package.json") && !result.includes("package.json *"), "non-selected file should not have marker");
	});

	test("generateFileMap() marks all files when selectedFiles not provided", () => {
		const files = [
			path.join(workspaceRoot, "index.ts"),
			path.join(workspaceRoot, "utils.ts")
		];

		const result = generateFileMap(files, workspaceRoot);

		assert.ok(result.includes("index.ts *"), "file should have marker");
		assert.ok(result.includes("utils.ts *"), "file should have marker");
	});

	test("generateFileMapMultiRoot() marks only selected files across workspaces", () => {
		const multiRootMap = new Map([
			["/workspace1", {
				workspaceName: "project1",
				workspacePath: "/workspace1",
				files: ["/workspace1/a.ts", "/workspace1/b.ts"]
			}]
		]);
		const selectedFiles = ["/workspace1/a.ts"];

		const result = generateFileMapMultiRoot(multiRootMap, selectedFiles);

		assert.ok(result.includes("a.ts *"), "selected file should have marker");
		assert.ok(result.includes("b.ts") && !result.includes("b.ts *"), "non-selected file should not have marker");
	});

	test("generateFileMap() includes selected ignored files merged with project files", () => {
		// Simulates the scenario where showIgnoredFiles is enabled:
		// - allProjectFiles: regular project files (respecting .gitignore)
		// - selectedFiles: includes both regular files AND ignored files the user selected
		// The merged file list should include the ignored file, marked as selected
		const projectFiles = [
			path.join(workspaceRoot, "src", "index.ts"),
			path.join(workspaceRoot, "src", "utils.ts")
		];
		const ignoredFile = path.join(workspaceRoot, "dist", "bundle.js"); // normally ignored
		
		// Merge project files with selected ignored file (simulates Set merge in extension.ts)
		const mergedFiles = [...new Set([...projectFiles, ignoredFile])].sort();
		const selectedFiles = [
			path.join(workspaceRoot, "src", "index.ts"),
			ignoredFile
		];

		const result = generateFileMap(mergedFiles, workspaceRoot, selectedFiles);

		// The ignored file should appear in the file map with selection marker
		assert.ok(result.includes("dist"), "should include dist directory from ignored file");
		assert.ok(result.includes("bundle.js *"), "selected ignored file should have marker");
		// Regular selected file should also be marked
		assert.ok(result.includes("index.ts *"), "selected regular file should have marker");
		// Non-selected file should not have marker
		assert.ok(result.includes("utils.ts") && !result.includes("utils.ts *"), "non-selected file should not have marker");
	});

	test("generateFileMapMultiRoot() includes selected ignored files in multi-root workspace", () => {
		// Same scenario but for multi-root workspaces
		const projectFiles = ["/workspace1/src/index.ts", "/workspace1/src/utils.ts"];
		const ignoredFile = "/workspace1/node_modules/pkg/index.js"; // normally ignored
		
		const mergedFiles = [...new Set([...projectFiles, ignoredFile])].sort();
		const selectedFiles = ["/workspace1/src/index.ts", ignoredFile];

		const multiRootMap = new Map([
			["/workspace1", {
				workspaceName: "project1",
				workspacePath: "/workspace1",
				files: mergedFiles
			}]
		]);

		const result = generateFileMapMultiRoot(multiRootMap, selectedFiles);

		assert.ok(result.includes("node_modules"), "should include node_modules directory from ignored file");
		assert.ok(result.includes("index.js *"), "selected ignored file should have marker");
		assert.ok(result.includes("src"), "should include src directory");
	});
});
