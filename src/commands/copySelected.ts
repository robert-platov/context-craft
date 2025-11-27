import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { MAX_PREVIEW_BYTES, MAX_COLLECTED_FILES } from "../constants";
import { FileTreeProvider } from "../FileTreeProvider";
import { generateFileMap, generateFileMapMultiRoot } from "../fileMapGenerator";
import { getIgnoreParser } from "../getIgnoreParser";
import { SettingsTreeProvider } from "../SettingsTreeProvider";
import { countTokens, countTokensFromText } from "../tokenCounter";
import { isBinary, collectFiles } from "../utils";

export function registerCopySelectedCommand(
  context: vscode.ExtensionContext,
  fileTreeProvider: FileTreeProvider,
  settingsProvider: SettingsTreeProvider,
  resolveSelectedFiles: (
    fileTree: FileTreeProvider,
    root?: vscode.Uri
  ) => Promise<string[]>
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("contextCraft.copySelected", async () => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showWarningMessage(
          "No workspace folder open. Cannot copy selected files."
        );
        return;
      }
      const absoluteFiles = (
        await resolveSelectedFiles(fileTreeProvider)
      ).sort();

      if (absoluteFiles.length === 0) {
        vscode.window.showInformationMessage("No non-ignored files resolved.");
        return;
      }

      const isMultiRoot = workspaceFolders.length > 1;
      const includeFileMap = settingsProvider.isFileMapEnabled();
      const fileMapIncludeAllFiles = settingsProvider.isFileMapAllFilesEnabled();

      // Group files by workspace folder if multi-root
      const filesByWorkspace = new Map<string, string[]>();
      for (const abs of absoluteFiles) {
        const fileUri = vscode.Uri.file(abs);
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);
        const workspaceKey = workspaceFolder?.uri.fsPath ?? workspaceFolders[0].uri.fsPath;
        if (!filesByWorkspace.has(workspaceKey)) {
          filesByWorkspace.set(workspaceKey, []);
        }
        filesByWorkspace.get(workspaceKey)!.push(abs);
      }

      // Generate file map if enabled
      let fileMapSection = "";
      if (includeFileMap) {
        // Determine which files to show in the map
        let fileMapFiles: string[];
        let selectedFilesForMarking: string[] | undefined;

        if (fileMapIncludeAllFiles) {
          // Collect all files from workspace(s), respecting .gitignore
          const allFilesPromises = workspaceFolders.map(async (ws) => {
            const ignoreParser = await getIgnoreParser(ws.uri);
            const capCounter = { count: 0 };
            return collectFiles(ws.uri, ignoreParser, ws.uri, undefined, MAX_COLLECTED_FILES, capCounter);
          });
          const allFilesArrays = await Promise.all(allFilesPromises);
          fileMapFiles = allFilesArrays.flat().sort();
          // Mark only the selected files with *
          selectedFilesForMarking = absoluteFiles;
        } else {
          fileMapFiles = absoluteFiles;
          // All files are selected, so mark all
          selectedFilesForMarking = undefined;
        }

        if (isMultiRoot) {
          const multiRootMap = new Map<string, { workspaceName: string; workspacePath: string; files: string[] }>();
          // Group file map files by workspace
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
      }

      let xmlChunks: string[] = ["<code_files>"];

      for (const [workspaceKey, files] of filesByWorkspace) {
        const workspaceFolder = workspaceFolders.find(ws => ws.uri.fsPath === workspaceKey);
        const workspaceName = workspaceFolder?.name ?? path.basename(workspaceKey);

        // Add workspace grouping only for multi-root
        if (isMultiRoot) {
          xmlChunks.push(`  <workspace name="${workspaceName}" path="${workspaceKey}">`);
        }

        for (const abs of files) {
          const fileUri = vscode.Uri.file(abs);
          const workspaceRootUri = workspaceFolder?.uri ?? workspaceFolders[0].uri;
          const rel = path.relative(workspaceRootUri.fsPath, abs);
          const fileName = path.basename(rel);
          const xmlPath = rel.split(path.sep).join("/");
          const indent = isMultiRoot ? "    " : "  ";

          try {
            const stats = await vscode.workspace.fs.stat(vscode.Uri.file(abs));
            if (stats.size > MAX_PREVIEW_BYTES) {
              xmlChunks.push(
                `${indent}<file name="${fileName}" path="${xmlPath}" truncated="true"/>`
              );
              continue;
            }
          } catch (statError) {
            console.error(
              `Error stating file ${abs} for XML generation:`,
              statError
            );
            xmlChunks.push(
              `${indent}<file name="${fileName}" path="${xmlPath}" error="true" comment="Error checking file size"/>`
            );
            continue;
          }

          if (await isBinary(abs)) {
            xmlChunks.push(
              `${indent}<file name="${fileName}" path="${xmlPath}" binary="true"/>`
            );
            continue;
          }

          const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(abs));
          const original = Buffer.from(bytes).toString("utf-8");
          const escaped = original.replaceAll("]]>", "]]]]><![CDATA[>");
          xmlChunks.push(
            `${indent}<file name="${fileName}" path="${xmlPath}"><![CDATA[`,
            escaped,
            `]]></file>`
          );
        }

        // Close workspace tag only for multi-root
        if (isMultiRoot) {
          xmlChunks.push(`  </workspace>`);
        }
      }

      xmlChunks.push("</code_files>");
      const codeFilesPayload = xmlChunks.join(os.EOL);

      // Build final payload with optional file map
      let finalPayload: string;
      if (fileMapSection) {
        finalPayload = fileMapSection + os.EOL + os.EOL + codeFilesPayload;
      } else {
        finalPayload = codeFilesPayload;
      }

      // Count tokens including file map
      const fileTokenCount = await countTokens(absoluteFiles);
      const fileMapTokenCount = fileMapSection ? countTokensFromText(fileMapSection) : 0;
      const totalTokenCount = fileTokenCount + fileMapTokenCount;

      await vscode.env.clipboard.writeText(finalPayload);
      vscode.window.showInformationMessage(
        `Copied ${absoluteFiles.length} file${
          absoluteFiles.length === 1 ? "" : "s"
        } ` +
          `(${totalTokenCount.toLocaleString()} tokens) as XML. Paste anywhere to share or prompt an LLM.`
      );
    })
  );
}
