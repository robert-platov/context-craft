import * as vscode from "vscode";

export const STATE_KEY_FILE_MAP_MODE = "contextCraft.fileMapMode";
export const STATE_KEY_SHOW_IGNORED_FILES = "contextCraft.showIgnoredFiles";

export type FileMapMode = "disabled" | "selected" | "all";

export interface SettingItem {
	id: string;
	label: string;
}

const FILE_MAP_OPTIONS: { mode: FileMapMode; label: string; description: string }[] = [
	{ mode: "disabled", label: "Disabled", description: "No file map in output" },
	{ mode: "selected", label: "Selected files", description: "Show only selected files in tree" },
	{ mode: "all", label: "All project files", description: "Show full project tree (respects .gitignore)" }
];

const SETTINGS: SettingItem[] = [
	{
		id: "fileMapMode",
		label: "File Map"
	},
	{
		id: "showIgnoredFiles",
		label: "Show Ignored Files"
	}
];

export class SettingsTreeProvider implements vscode.TreeDataProvider<SettingItem> {
	private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<SettingItem | undefined>();
	public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

	private fileMapMode: FileMapMode;
	private showIgnoredFiles: boolean;
	private readonly context: vscode.ExtensionContext;
	private readonly onSettingChangedCallback: () => void;
	private onShowIgnoredFilesChangedCallback: (() => void) | undefined;
	private onShowIgnoredFilesDisabledCallback: (() => Promise<void>) | undefined;

	public constructor(context: vscode.ExtensionContext, onSettingChanged: () => void) {
		this.context = context;
		this.onSettingChangedCallback = onSettingChanged;
		this.fileMapMode = context.workspaceState.get<FileMapMode>(STATE_KEY_FILE_MAP_MODE) ?? "selected";
		this.showIgnoredFiles = context.workspaceState.get<boolean>(STATE_KEY_SHOW_IGNORED_FILES) ?? false;
	}

	public setOnShowIgnoredFilesChanged(callback: () => void): void {
		this.onShowIgnoredFilesChangedCallback = callback;
	}

	public setOnShowIgnoredFilesDisabled(callback: () => Promise<void>): void {
		this.onShowIgnoredFilesDisabledCallback = callback;
	}

	public getTreeItem(element: SettingItem): vscode.TreeItem {
		const treeItem = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
		treeItem.id = element.id;

		if (element.id === "fileMapMode") {
			const currentOption = FILE_MAP_OPTIONS.find(opt => opt.mode === this.fileMapMode);
			treeItem.description = currentOption?.label ?? "Selected files";
			treeItem.tooltip = currentOption?.description;
			treeItem.command = {
				command: "contextCraft.selectFileMapMode",
				title: "Select File Map Mode"
			};
			treeItem.iconPath = new vscode.ThemeIcon("list-tree");
		} else if (element.id === "showIgnoredFiles") {
			treeItem.description = this.showIgnoredFiles ? "On" : "Off";
			treeItem.tooltip = "Show files ignored by .gitignore in the file tree";
			treeItem.command = {
				command: "contextCraft.toggleShowIgnoredFiles",
				title: "Toggle Show Ignored Files"
			};
			treeItem.iconPath = new vscode.ThemeIcon(this.showIgnoredFiles ? "eye" : "eye-closed");
		}

		return treeItem;
	}

	public getChildren(element?: SettingItem): SettingItem[] {
		if (element) {
			return [];
		}
		return SETTINGS;
	}

	public getParent(_element: SettingItem): vscode.ProviderResult<SettingItem> {
		return undefined;
	}

	public async showFileMapModeQuickPick(): Promise<void> {
		const items = FILE_MAP_OPTIONS.map(opt => ({
			label: opt.label,
			description: opt.description,
			mode: opt.mode,
			picked: opt.mode === this.fileMapMode
		}));

		const selected = await vscode.window.showQuickPick(items, {
			placeHolder: "Select file map mode",
			title: "File Map"
		});

		if (selected) {
			this.fileMapMode = selected.mode;
			await this.context.workspaceState.update(STATE_KEY_FILE_MAP_MODE, selected.mode);
			this.onDidChangeTreeDataEmitter.fire(undefined);
			this.onSettingChangedCallback();
		}
	}

	public getFileMapMode(): FileMapMode {
		return this.fileMapMode;
	}

	public isFileMapEnabled(): boolean {
		return this.fileMapMode !== "disabled";
	}

	public isFileMapAllFilesEnabled(): boolean {
		return this.fileMapMode === "all";
	}

	public isShowIgnoredFilesEnabled(): boolean {
		return this.showIgnoredFiles;
	}

	public async toggleShowIgnoredFiles(): Promise<void> {
		const wasEnabled = this.showIgnoredFiles;
		this.showIgnoredFiles = !this.showIgnoredFiles;
		await this.context.workspaceState.update(STATE_KEY_SHOW_IGNORED_FILES, this.showIgnoredFiles);
		
		// When disabling, clean up any selected ignored files first
		if (wasEnabled && !this.showIgnoredFiles) {
			await this.onShowIgnoredFilesDisabledCallback?.();
		}
		
		this.onDidChangeTreeDataEmitter.fire(undefined);
		this.onShowIgnoredFilesChangedCallback?.();
	}

	public refresh(): void {
		this.onDidChangeTreeDataEmitter.fire(undefined);
	}
}
