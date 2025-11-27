import * as path from "path";
import * as vscode from "vscode";
import { MAX_COLLECTED_FILES } from "./constants";
import { generateFileMap, generateFileMapMultiRoot } from "./fileMapGenerator";
import { getIgnoreParser } from "./getIgnoreParser";
import { collectFiles } from "./utils";

export interface FileMapResult {
	fileMapSection: string;
	fileMapFiles: string[];
}

export interface GenerateFileMapOptions {
	workspaceFolders: readonly vscode.WorkspaceFolder[];
	selectedFiles: string[];
	includeAllFiles: boolean;
	signal?: AbortSignal;
}

/**
 * Generates a file map section for the given options.
 * Handles both single-root and multi-root workspaces.
 * When includeAllFiles is true, collects all project files and merges with selected files.
 */
export async function generateFileMapSection(options: GenerateFileMapOptions): Promise<FileMapResult> {
	const { workspaceFolders, selectedFiles, includeAllFiles, signal } = options;

	if (workspaceFolders.length === 0) {
		return { fileMapSection: "", fileMapFiles: [] };
	}

	const isMultiRoot = workspaceFolders.length > 1;
	let fileMapFiles: string[];
	let selectedFilesForMarking: string[] | undefined;

	if (includeAllFiles) {
		// Collect all files from workspace(s), respecting .gitignore
		const allFilesPromises = workspaceFolders.map(async (ws) => {
			const ignoreParser = await getIgnoreParser(ws.uri);
			const capCounter = { count: 0 };
			return collectFiles(ws.uri, ignoreParser, ws.uri, signal, MAX_COLLECTED_FILES, capCounter);
		});
		const allFilesArrays = await Promise.all(allFilesPromises);
		
		// Merge all project files with selected files (which may include ignored files)
		const allProjectFiles = new Set(allFilesArrays.flat());
		for (const file of selectedFiles) {
			allProjectFiles.add(file);
		}
		fileMapFiles = Array.from(allProjectFiles).sort();
		selectedFilesForMarking = selectedFiles;
	} else {
		fileMapFiles = selectedFiles;
		selectedFilesForMarking = undefined;
	}

	if (fileMapFiles.length === 0) {
		return { fileMapSection: "", fileMapFiles: [] };
	}

	let fileMapSection: string;
	if (isMultiRoot) {
		const multiRootMap = new Map<string, { workspaceName: string; workspacePath: string; files: string[] }>();
		const fileMapByWorkspace = new Map<string, string[]>();
		
		for (const file of fileMapFiles) {
			const fileUri = vscode.Uri.file(file);
			const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);
			const workspaceKey = workspaceFolder?.uri.fsPath ?? workspaceFolders[0].uri.fsPath;
			if (!fileMapByWorkspace.has(workspaceKey)) {
				fileMapByWorkspace.set(workspaceKey, []);
			}
			fileMapByWorkspace.get(workspaceKey)!.push(file);
		}
		
		for (const [workspaceKey, files] of fileMapByWorkspace) {
			const workspaceFolder = workspaceFolders.find(ws => ws.uri.fsPath === workspaceKey);
			const workspaceName = workspaceFolder?.name ?? path.basename(workspaceKey);
			multiRootMap.set(workspaceKey, { workspaceName, workspacePath: workspaceKey, files });
		}
		
		fileMapSection = generateFileMapMultiRoot(multiRootMap, selectedFilesForMarking);
	} else {
		const workspaceRoot = workspaceFolders[0].uri.fsPath;
		fileMapSection = generateFileMap(fileMapFiles, workspaceRoot, selectedFilesForMarking);
	}

	return { fileMapSection, fileMapFiles };
}
