import ignore from "ignore";
import * as path from "path";
import * as vscode from "vscode";
import { registerCopySelectedCommand } from "./commands/copySelected";
import { registerRefreshCommand } from "./commands/refresh";
import { registerUnselectAllCommand } from "./commands/unselectAll";
import { registerSelectGitChangesCommand } from "./commands/selectGitChanges";
import { registerOpenFileCommand } from "./commands/openFile";
import { registerOpenToSideCommand } from "./commands/openToSide";
import { registerRevealInOSCommand } from "./commands/revealInOS";
import { registerOpenInTerminalCommand } from "./commands/openInTerminal";
import { registerCopyPathCommand } from "./commands/copyPath";
import { registerCopyRelativePathCommand } from "./commands/copyRelativePath";
import { registerRenameFileCommand } from "./commands/renameFile";
import { registerDeleteFileCommand } from "./commands/deleteFile";
import { STATE_KEY_SELECTED, MAX_COLLECTED_FILES } from "./constants";
import { debounce } from "./debounce";
import { FileTreeProvider } from "./FileTreeProvider";
import { generateFileMapSection } from "./fileMapUtils";
import { DEFAULT_IGNORE_PATTERNS, getIgnoreParser } from "./getIgnoreParser";
import { toggleSelection } from "./selectionLogic";
import { SettingsTreeProvider } from "./SettingsTreeProvider";
import { countTokens, countTokensFromText } from "./tokenCounter";
import { collectFiles, formatTokenCount } from "./utils";
		
export let ignoreParserCache: Map<string, { parser: ReturnType<typeof ignore>, mtime: number }> = new Map();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	let fileTreeProvider: FileTreeProvider;
	let settingsProvider: SettingsTreeProvider;
	let treeView: vscode.TreeView<vscode.Uri>;
	let tokenStatusBar: vscode.StatusBarItem;
	let currentAbort: AbortController | undefined;
	let refreshSeq = 0;
    

	async function resolveSelectedFiles(
		fileTree: FileTreeProvider,
		_root?: vscode.Uri,
		signal?: AbortSignal
	): Promise<string[]> {
		const selections = Array.from(fileTree.checkedPaths);
		console.log(`[ContextCraft] resolveSelectedFiles selections=${selections.length}`);
		const byRoot = new Map<string, { root: vscode.Uri; uris: vscode.Uri[] }>();
		for (const sel of selections) {
			const uri = vscode.Uri.file(sel);
			const ws = vscode.workspace.getWorkspaceFolder(uri);
			if (!ws) { continue; }
			const key = ws.uri.fsPath;
			if (!byRoot.has(key)) {
				byRoot.set(key, { root: ws.uri, uris: [] });
			}
			byRoot.get(key)!.uris.push(uri);
		}

		console.log(`[ContextCraft] resolveSelectedFiles roots=${byRoot.size}`);
		for (const [key, group] of byRoot) {
			console.log(`[ContextCraft]  root=${key} selections=${group.uris.length}`);
		}

		// When showIgnoredFiles is enabled, use parser with only default patterns (always exclude .git)
		const includeIgnoredFiles = settingsProvider?.isShowIgnoredFilesEnabled() ?? false;

        const nestedPerRoot: string[][] = await Promise.all(
            Array.from(byRoot.values()).map(async (group) => {
                const ignoreParser = includeIgnoredFiles
					? ignore().add(DEFAULT_IGNORE_PATTERNS)
					: await getIgnoreParser(group.root);
                const capCounter = { count: 0 };
                const nestedArrays = await Promise.all(
                    group.uris.map(async (uri) => {
                        try {
                            const tSel0 = Date.now();
                            const filesForSel = await collectFiles(
                                uri,
                                ignoreParser,
                                group.root,
                                signal,
                                MAX_COLLECTED_FILES,
                                capCounter
                            );
                            const tSel1 = Date.now();
                            console.log(`[ContextCraft]  collected ${filesForSel.length} files from ${uri.fsPath} in ${tSel1 - tSel0}ms`);
                            return filesForSel;
                        } catch (error) {
                            console.error("[ContextCraft] collectFiles failed for selection", uri.fsPath, error);
                            return [] as string[];
                        }
                    })
                );
                if (capCounter.count >= MAX_COLLECTED_FILES) {
                    console.warn(`[ContextCraft] traversal capped at ${MAX_COLLECTED_FILES} files for root ${group.root.fsPath}`);
                }
                return nestedArrays.flat();
            })
        );

		const files = nestedPerRoot.flat();
		return Array.from(new Set(files));
	}

	interface StatusOptions {
		fileMapEnabled?: boolean;
		filesCount?: number;
		tokensText?: string;
		isCalculating?: boolean;
	}

	const buildStatusText = (options: StatusOptions): string => {
		const parts: string[] = [];

		if (options.fileMapEnabled) {
			parts.push("file map");
		}

		if (options.filesCount !== undefined) {
			parts.push(`${options.filesCount} file${options.filesCount === 1 ? "" : "s"}`);
		}

		if (options.tokensText) {
			parts.push(options.tokensText);
		}

		return parts.join(" | ");
	};

	const updateStatusBar = (options: StatusOptions) => {
		const displayText = buildStatusText(options);
		const icon = options.isCalculating ? "$(sync~spin)" : "$(symbol-string)";
		if (tokenStatusBar) {
			tokenStatusBar.text = `${icon} ${displayText}`;
		}
		if (treeView) {
			treeView.message = displayText;
		}
	};

	// Extracted so we can also call immediately when needed
	const refreshAndUpdate = async () => {
		const mySeq = ++refreshSeq;
		try { currentAbort?.abort(); } catch {}
		currentAbort = new AbortController();
		fileTreeProvider.refresh();
		const workspaceFolders = vscode.workspace.workspaceFolders;
		const hasWorkspace = (workspaceFolders?.length ?? 0) > 0;
		if (!hasWorkspace) {
			updateStatusBar({ tokensText: "No workspace" });
			return;
		}

		// Get file map settings early for status display
		const fileMapEnabled = settingsProvider?.isFileMapEnabled() ?? false;
		const includeAllFiles = settingsProvider?.isFileMapAllFilesEnabled() ?? false;

		const checkedCount = fileTreeProvider.checkedPaths.size;
		console.log(`[ContextCraft] refresh start seq=${mySeq} checked=${checkedCount}`);

		// Initial calculating state (don't know file count yet)
		updateStatusBar({
			fileMapEnabled,
			tokensText: "Calculating…",
			isCalculating: true
		});

		const t0 = Date.now();
		const resolvedFiles = await resolveSelectedFiles(fileTreeProvider, undefined, currentAbort.signal);
		if (mySeq !== refreshSeq) { return; }
		const t1 = Date.now();
		console.log(`[ContextCraft] resolveSelectedFiles seq=${mySeq} files=${resolvedFiles.length} in ${t1 - t0}ms`);
		const filesCount = resolvedFiles.length;

		// Update with file count, still calculating tokens
		updateStatusBar({
			fileMapEnabled,
			filesCount,
			tokensText: "Calculating…",
			isCalculating: true
		});

		const t2 = Date.now();
		const fileTokens = await countTokens(resolvedFiles, currentAbort.signal);
		if (mySeq !== refreshSeq) { return; }
		const t3 = Date.now();
		console.log(`[ContextCraft] countTokens seq=${mySeq} fileTokens=${fileTokens} in ${t3 - t2}ms`);

		// Calculate file map tokens if enabled
		let fileMapTokens = 0;

		// Calculate file map tokens when:
		// - File map is enabled AND there are selected files, OR
		// - File map mode is "all" (show full project tree even with no selections)
		if (fileMapEnabled && (resolvedFiles.length > 0 || includeAllFiles)) {
			const { fileMapSection } = await generateFileMapSection({
				workspaceFolders: workspaceFolders!,
				selectedFiles: resolvedFiles,
				includeAllFiles,
				signal: currentAbort?.signal
			});
			if (mySeq !== refreshSeq) { return; }

			if (fileMapSection) {
				fileMapTokens = countTokensFromText(fileMapSection);
			}
		}

		const totalTokens = fileTokens + fileMapTokens;
		const t4 = Date.now();
		console.log(`[ContextCraft] countTokens seq=${mySeq} totalTokens=${totalTokens} (files=${fileTokens}, fileMap=${fileMapTokens}) in ${t4 - t0}ms`);

		// Final state with token count
		updateStatusBar({
			fileMapEnabled,
			filesCount,
			tokensText: formatTokenCount(totalTokens)
		});
	};

	const debouncedRefreshAndUpdate = debounce(refreshAndUpdate, 200);

	const handleWorkspaceFoldersChanged = async () => {
		console.log("[ContextCraft] Workspace folders changed, pruning selections and refreshing tree");
		const selectionsPruned = pruneSelectionsOutsideWorkspace(fileTreeProvider);
		if (selectionsPruned) {
			await context.workspaceState.update(
				STATE_KEY_SELECTED,
				Array.from(fileTreeProvider.checkedPaths)
			);
		}
		debouncedRefreshAndUpdate();
	};

    

	const persisted: string[] =
		context.workspaceState.get<string[]>(STATE_KEY_SELECTED) ?? [];
	fileTreeProvider = new FileTreeProvider(new Set(persisted), context, debouncedRefreshAndUpdate);

	treeView = vscode.window.createTreeView("contextCraftFileBrowser", {
		treeDataProvider: fileTreeProvider,
		showCollapseAll: true,
		canSelectMany: true,
		manageCheckboxStateManually: true
	});
	context.subscriptions.push(treeView);

	// Settings tree view
	settingsProvider = new SettingsTreeProvider(context, debouncedRefreshAndUpdate);
	const settingsTreeView = vscode.window.createTreeView("contextCraftSettings", {
		treeDataProvider: settingsProvider
	});
	context.subscriptions.push(settingsTreeView);

	// Wire up show ignored files setting
	fileTreeProvider.setShowIgnoredFilesGetter(() => settingsProvider.isShowIgnoredFilesEnabled());
	settingsProvider.setOnShowIgnoredFilesChanged(() => {
		fileTreeProvider.clearCacheAndRefresh();
	});
	
	// When show ignored files is disabled, remove any selected ignored paths
	settingsProvider.setOnShowIgnoredFilesDisabled(async () => {
		const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
		if (workspaceFolders.length === 0) { return; }
		
		// Group checked paths by workspace
		const pathsToRemove: string[] = [];
		for (const checkedPath of fileTreeProvider.checkedPaths) {
			const uri = vscode.Uri.file(checkedPath);
			const ws = vscode.workspace.getWorkspaceFolder(uri);
			if (!ws) { continue; }
			
			const ignoreParser = await getIgnoreParser(ws.uri);
			const relativePath = path.relative(ws.uri.fsPath, checkedPath).split(path.sep).join("/");
			
			// Check if this path is ignored (try both file and directory patterns)
			const isIgnored = relativePath !== "" && (
				ignoreParser.ignores(relativePath) || 
				ignoreParser.ignores(`${relativePath}/`)
			);
			
			if (isIgnored) {
				pathsToRemove.push(checkedPath);
			}
		}
		
		// Remove ignored paths from selection
		if (pathsToRemove.length > 0) {
			for (const pathToRemove of pathsToRemove) {
				fileTreeProvider.checkedPaths.delete(pathToRemove);
			}
			// Persist updated selection
			await context.workspaceState.update(
				STATE_KEY_SELECTED,
				Array.from(fileTreeProvider.checkedPaths)
			);
			console.log(`[ContextCraft] Removed ${pathsToRemove.length} ignored paths from selection`);
		}
	});

	// Register command for file map mode selection
	context.subscriptions.push(
		vscode.commands.registerCommand("contextCraft.selectFileMapMode", async () => {
			await settingsProvider.showFileMapModeQuickPick();
		})
	);

	// Register command for toggling show ignored files
	context.subscriptions.push(
		vscode.commands.registerCommand("contextCraft.toggleShowIgnoredFiles", async () => {
			await settingsProvider.toggleShowIgnoredFiles();
		})
	);

	const focusActiveEditorInTree = (options?: { skipIfSelected?: boolean }) => {
		const activeEditor = vscode.window.activeTextEditor;
		if (!activeEditor) {
			return;
		}
		const documentUri = activeEditor.document.uri;
		if (documentUri.scheme !== "file") {
			return;
		}
		if (!vscode.workspace.getWorkspaceFolder(documentUri)) {
			return;
		}
		if (options?.skipIfSelected) {
			const alreadySelected = treeView.selection.some(
				(selectedUri) => selectedUri.fsPath === documentUri.fsPath
			);
			if (alreadySelected) {
				return;
			}
		}
		treeView.reveal(
			documentUri,
			{
				select: true,
				focus: true,
				expand: true
			}
		).then(undefined, (error: unknown) => {
			console.error("Could not reveal in tree:", error);
		});
	};

	tokenStatusBar = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Left,
		95
	);
	tokenStatusBar.tooltip = "Tokens that will be copied by Context Craft";
	tokenStatusBar.show();
	// Initial state - will be updated by refreshAndUpdate
	updateStatusBar({
		fileMapEnabled: settingsProvider?.isFileMapEnabled() ?? false,
		filesCount: 0,
		tokensText: formatTokenCount(0)
	});
	context.subscriptions.push(tokenStatusBar);

	registerUnselectAllCommand(context, fileTreeProvider, debouncedRefreshAndUpdate);
	registerSelectGitChangesCommand(context, fileTreeProvider, debouncedRefreshAndUpdate);
	registerCopySelectedCommand(context, fileTreeProvider, settingsProvider, resolveSelectedFiles);
	registerRefreshCommand(context, fileTreeProvider, debouncedRefreshAndUpdate);
	registerOpenFileCommand(context);
	registerOpenToSideCommand(context);
	registerRevealInOSCommand(context);
	registerOpenInTerminalCommand(context);
	registerCopyPathCommand(context);
	registerCopyRelativePathCommand(context);
	registerRenameFileCommand(context, fileTreeProvider, debouncedRefreshAndUpdate);
	registerDeleteFileCommand(context, fileTreeProvider, debouncedRefreshAndUpdate);

		const checkboxDisposable = treeView.onDidChangeCheckboxState(async (event) => {
			try {
				const togglePromises: Promise<void>[] = [];
				console.log(`[ContextCraft] checkbox change items=${event.items.length}`);
				for (const [element, checkboxState] of event.items) {
					togglePromises.push(
						toggleSelection(
							element,
							checkboxState === vscode.TreeItemCheckboxState.Checked,
							fileTreeProvider
						)
					);
				}
				await Promise.all(togglePromises);
				console.log(`[ContextCraft] checkbox toggled; checkedPaths.size=${fileTreeProvider.checkedPaths.size}`);
				// Persist selection state, but do not block UI updates
				void context.workspaceState.update(
					STATE_KEY_SELECTED,
					Array.from(fileTreeProvider.checkedPaths)
				).then(undefined, (err: unknown) => console.error("[ContextCraft] workspaceState update failed", err));
			} catch (error) {
				console.error("[ContextCraft] Checkbox handler failed:", error);
			} finally {
				await refreshAndUpdate();
			}
		});
	context.subscriptions.push(checkboxDisposable);

	const visibilityDisposable = treeView.onDidChangeVisibility((event) => {
		if (!event.visible) {
			return;
		}
		focusActiveEditorInTree({ skipIfSelected: true });
	});
	context.subscriptions.push(visibilityDisposable);

	if (treeView.visible) {
		focusActiveEditorInTree({ skipIfSelected: true });
	}

	debouncedRefreshAndUpdate();

	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(() => {
			if (!treeView.visible) {
				return;
			}
			focusActiveEditorInTree({ skipIfSelected: true });
		})
	);

	context.subscriptions.push(
		vscode.workspace.onDidChangeWorkspaceFolders(() => {
			void handleWorkspaceFoldersChanged();
		})
	);
}

export function deactivate(): void {
	// noop
}

function pruneSelectionsOutsideWorkspace(fileTreeProvider: FileTreeProvider): boolean {
	const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
	if (workspaceFolders.length === 0) {
		if (fileTreeProvider.checkedPaths.size === 0) {
			return false;
		}
		fileTreeProvider.checkedPaths.clear();
		return true;
	}
	let changed = false;
	for (const fsPath of Array.from(fileTreeProvider.checkedPaths)) {
		const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fsPath));
		if (!folder) {
			fileTreeProvider.checkedPaths.delete(fsPath);
			changed = true;
		}
	}
	return changed;
}
