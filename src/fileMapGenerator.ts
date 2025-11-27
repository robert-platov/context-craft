import * as path from "path";

interface TreeNode {
	name: string;
	isFile: boolean;
	isSelected: boolean;
	children: Map<string, TreeNode>;
}

function createTreeNode(name: string, isFile: boolean, isSelected: boolean): TreeNode {
	return {
		name,
		isFile,
		isSelected,
		children: new Map()
	};
}

function buildTree(files: string[], workspaceRoot: string, selectedFiles?: Set<string>): TreeNode {
	const root = createTreeNode(path.basename(workspaceRoot), false, false);

	for (const filePath of files) {
		const relativePath = path.relative(workspaceRoot, filePath);
		const parts = relativePath.split(path.sep);

		let current = root;
		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			const isLast = i === parts.length - 1;
			// Mark as selected if: no selectedFiles set provided (mark all), or file is in selectedFiles
			const isSelected = isLast && (selectedFiles === undefined || selectedFiles.has(filePath));

			if (!current.children.has(part)) {
				current.children.set(part, createTreeNode(part, isLast, isSelected));
			} else if (isLast && isSelected) {
				// Update selection status if node already exists
				current.children.get(part)!.isSelected = true;
			}
			current = current.children.get(part)!;
		}
	}

	return root;
}

function sortChildren(children: Map<string, TreeNode>): TreeNode[] {
	const entries = Array.from(children.values());
	return entries.sort((a, b) => {
		// Directories first, then files
		if (!a.isFile && b.isFile) {
			return -1;
		}
		if (a.isFile && !b.isFile) {
			return 1;
		}
		// Alphabetical within same type
		return a.name.localeCompare(b.name);
	});
}

function renderTree(
	node: TreeNode,
	prefix: string,
	isLast: boolean,
	isRoot: boolean,
	lines: string[]
): void {
	if (isRoot) {
		// Root node - just render children
		const sortedChildren = sortChildren(node.children);
		for (let i = 0; i < sortedChildren.length; i++) {
			const child = sortedChildren[i];
			const childIsLast = i === sortedChildren.length - 1;
			renderTree(child, "", childIsLast, false, lines);
		}
		return;
	}

	const connector = isLast ? "└── " : "├── ";
	const marker = node.isSelected ? " *" : "";
	lines.push(`${prefix}${connector}${node.name}${marker}`);

	if (node.children.size > 0) {
		const newPrefix = prefix + (isLast ? "    " : "│   ");
		const sortedChildren = sortChildren(node.children);
		for (let i = 0; i < sortedChildren.length; i++) {
			const child = sortedChildren[i];
			const childIsLast = i === sortedChildren.length - 1;
			renderTree(child, newPrefix, childIsLast, false, lines);
		}
	}
}

export function generateFileMap(files: string[], workspaceRoot: string, selectedFiles?: string[]): string {
	if (files.length === 0) {
		return "";
	}

	const selectedSet = selectedFiles ? new Set(selectedFiles) : undefined;
	const tree = buildTree(files, workspaceRoot, selectedSet);
	const lines: string[] = [workspaceRoot];

	renderTree(tree, "", true, true, lines);

	return `<file_map>\n${lines.join("\n")}\n\n(* denotes selected files)\n</file_map>`;
}

export function generateFileMapMultiRoot(
	filesByWorkspace: Map<string, { workspaceName: string; workspacePath: string; files: string[] }>,
	selectedFiles?: string[]
): string {
	if (filesByWorkspace.size === 0) {
		return "";
	}

	const selectedSet = selectedFiles ? new Set(selectedFiles) : undefined;
	const allLines: string[] = [];

	for (const [, { workspaceName, workspacePath, files }] of filesByWorkspace) {
		if (files.length === 0) {
			continue;
		}

		const tree = buildTree(files, workspacePath, selectedSet);
		const lines: string[] = [`${workspacePath}`];
		renderTree(tree, "", true, true, lines);
		allLines.push(...lines);
		allLines.push(""); // Empty line between workspaces
	}

	// Remove trailing empty line
	if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
		allLines.pop();
	}

	return `<file_map>\n${allLines.join("\n")}\n</file_map>`;
}
