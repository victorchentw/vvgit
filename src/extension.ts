import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  BlameHoverProvider,
  FileBlameController,
  InlineBlameController,
} from "./blame";
import {
  BranchInfo,
  CommitDetails,
  CommitFile,
  CommitSummary,
  GitCommandError,
  GitService,
} from "./git";
import { GitDocumentProvider } from "./virtual-documents";

interface FileTarget {
  uri: vscode.Uri;
  document: vscode.TextDocument;
  root: string;
  relativePath: string;
}

interface RefPickItem extends vscode.QuickPickItem {
  ref: string;
}

interface CommitPickItem extends RefPickItem {
  commit: CommitSummary;
}

interface CommitFilePickItem extends vscode.QuickPickItem {
  file: CommitFile;
}

type CommitAction = "message" | "patch" | "filePatch" | "allPatches" | "files" | "copyHash" | "squash";
interface CommitActionPickItem extends vscode.QuickPickItem {
  action: CommitAction;
}

interface BranchPickItem extends vscode.QuickPickItem {
  branch: BranchInfo;
}

const SEARCH_START_LENGTH = 4;
const SEARCH_CONTINUE_LENGTH = 3;

function dateLabel(value: string): string {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return value || "unknown date";
  return date.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function shortError(error: unknown): string {
  if (error instanceof GitCommandError) return error.stderr || error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

function singleLine(value: string, max = 300): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function commitPreview(details: CommitDetails): string {
  return singleLine(details.body || details.subject, 280) || "(no commit message)";
}

function commitFileLabel(file: CommitFile): string {
  return file.previousPath ? `${file.path} ← ${file.previousPath}` : file.path;
}

function branchFileName(branch: string): string {
  const safe = branch
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return safe || "branch";
}

async function exists(pathname: string): Promise<boolean> {
  try {
    await fs.access(pathname);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomically(pathname: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(pathname), { recursive: true });
  const temporary = `${pathname}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    await fs.writeFile(temporary, content, "utf8");
    // A confirmed overwrite is intentionally allowed. Removing the old file
    // first keeps this compatible with Windows, where rename cannot replace
    // an existing file.
    await fs.rm(pathname, { force: true });
    await fs.rename(temporary, pathname);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const git = new GitService();
  const output = vscode.window.createOutputChannel("VV Git");
  const blame = new InlineBlameController(git);
  const fileBlame = new FileBlameController(git);
  const documents = new GitDocumentProvider(git);
  const branchStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
  branchStatus.command = "vvgit.showBranches";
  branchStatus.tooltip = "VV Git: browse branches";
  branchStatus.name = "VV Git branch";

  context.subscriptions.push(
    output,
    blame,
    fileBlame,
    documents,
    branchStatus,
    vscode.languages.registerHoverProvider({ scheme: "file" }, new BlameHoverProvider(blame, fileBlame)),
    vscode.workspace.registerTextDocumentContentProvider("vvgit-ref", documents),
    vscode.workspace.registerTextDocumentContentProvider("vvgit-worktree", documents),
    vscode.workspace.registerTextDocumentContentProvider("vvgit-diff", documents),
  );

  const showCommandError = (action: string, error: unknown): void => {
    const text = shortError(error);
    output.appendLine(`[error] ${action}: ${text}`);
    vscode.window.showErrorMessage(`${action}: ${singleLine(text)}`);
  };

  const repositoryRoot = async (resource?: vscode.Uri): Promise<string> => {
    const active = vscode.window.activeTextEditor;
    const candidate = resource?.scheme === "file" ? resource : active?.document.uri;
    return git.repositoryRoot(candidate?.scheme === "file" ? candidate : undefined);
  };

  const fileTarget = async (resource?: vscode.Uri): Promise<FileTarget | undefined> => {
    let uri = resource?.scheme === "file" ? resource : vscode.window.activeTextEditor?.document.uri;
    if (!uri) {
      const selected = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: "Use file for Git action",
      });
      uri = selected?.[0];
    }
    if (!uri || uri.scheme !== "file") return undefined;

    const document = await vscode.workspace.openTextDocument(uri);
    const root = await git.repositoryRoot(uri);
    return { uri, document, root, relativePath: git.relativePath(root, uri) };
  };

  const pickItems = async <T extends vscode.QuickPickItem & { ref: string }>(
    items: T[],
    placeholder: string,
    allowTypedReference = false,
  ): Promise<string | undefined> => {
    if (!items.length && !allowTypedReference) return undefined;
    return new Promise<string | undefined>((resolve) => {
      const picker = vscode.window.createQuickPick<T>();
      picker.items = items;
      picker.placeholder = placeholder;
      picker.matchOnDescription = true;
      picker.matchOnDetail = true;
      picker.ignoreFocusOut = false;
      let settled = false;
      const finish = (value: string | undefined): void => {
        if (settled) return;
        settled = true;
        picker.hide();
        picker.dispose();
        resolve(value);
      };
      picker.onDidAccept(() => {
        const selected = picker.selectedItems[0]?.ref;
        const typed = picker.value.trim();
        finish(selected || (allowTypedReference && typed ? typed : undefined));
      });
      picker.onDidHide(() => finish(undefined));
      picker.show();
    });
  };

  const pickBranch = async (
    root: string,
    placeholder: string,
    localOnly = false,
  ): Promise<string | undefined> => {
    const branches = (await git.branches(root)).filter((branch) => !localOnly || !branch.isRemote);
    const current = await git.currentBranch(root);
    const items: BranchPickItem[] = branches.map((branch) => ({
      label: `${branch.isRemote ? "$(cloud)" : "$(git-branch)"} ${branch.name}`,
      description: [
        branch.name === current ? "current" : undefined,
        branch.isRemote ? "remote" : "local",
        branch.hash.slice(0, 10),
      ].filter(Boolean).join(" · "),
      detail: branch.subject || "(no commit message)",
      branch,
    }));
    if (!items.length) {
      vscode.window.showInformationMessage("No Git branches were found.");
      return undefined;
    }
    return new Promise<string | undefined>((resolve) => {
      const picker = vscode.window.createQuickPick<BranchPickItem>();
      picker.items = items;
      picker.placeholder = placeholder;
      picker.matchOnDescription = true;
      picker.matchOnDetail = true;
      picker.ignoreFocusOut = false;
      let settled = false;
      const finish = (value: string | undefined): void => {
        if (settled) return;
        settled = true;
        picker.hide();
        picker.dispose();
        resolve(value);
      };
      picker.onDidAccept(() => finish(picker.selectedItems[0]?.branch.name));
      picker.onDidHide(() => finish(undefined));
      picker.show();
    });
  };

  const referenceItems = async (root: string, includeBranches = true): Promise<RefPickItem[]> => {
    const items: RefPickItem[] = [];
    const seen = new Set<string>();
    const add = (item: RefPickItem): void => {
      if (!item.ref || seen.has(item.ref)) return;
      seen.add(item.ref);
      items.push(item);
    };

    add({ label: "$(git-commit) HEAD", description: "current checkout", ref: "HEAD" });
    if (includeBranches) {
      for (const branch of await git.branches(root)) {
        add({
          label: `${branch.isRemote ? "$(cloud)" : "$(git-branch)"} ${branch.name}`,
          description: `${branch.isRemote ? "remote" : "local"} · ${branch.hash.slice(0, 10)} · ${dateLabel(branch.date)}`,
          detail: branch.subject || "(no commit message)",
          ref: branch.name,
        });
      }
    }
    for (const commit of await git.log(root, { max: 250 })) {
      add({
        label: `$(git-commit) ${commit.shortHash} ${commit.subject}`,
        description: `${commit.author} · ${dateLabel(commit.date)}`,
        ref: commit.hash,
      });
    }
    return items;
  };

  const pickReference = async (root: string, placeholder: string): Promise<string | undefined> => {
    return pickItems(await referenceItems(root), placeholder, true);
  };

  const pickCommitFromList = async (
    root: string,
    commits: CommitSummary[],
    placeholder: string,
  ): Promise<string | undefined> => {
    const items: CommitPickItem[] = commits.map((commit) => ({
      label: `$(git-commit) ${commit.shortHash} ${commit.subject}`,
      description: `${commit.author} · ${dateLabel(commit.date)}`,
      detail: "Focus this commit to preview its full message",
      ref: commit.hash,
      commit,
    }));

    return new Promise<string | undefined>((resolve) => {
      const picker = vscode.window.createQuickPick<CommitPickItem>();
      picker.items = items;
      picker.placeholder = placeholder;
      picker.prompt = "Focus a commit to preview its message below";
      picker.matchOnDescription = true;
      picker.matchOnDetail = true;
      picker.keepScrollPosition = true;
      picker.ignoreFocusOut = false;

      let currentItems = items;
      let settled = false;
      let previewRequest = 0;
      const previewCache = new Map<string, string>();

      const setPreview = (item: CommitPickItem, preview: string): void => {
        if (item.detail === preview) return;
        item.detail = preview;
        picker.items = [...currentItems];
      };

      const loadPreview = async (active: readonly CommitPickItem[]): Promise<void> => {
        const item = active[0];
        if (!item || settled) return;
        const cached = previewCache.get(item.ref);
        if (cached) {
          setPreview(item, cached);
          return;
        }

        const request = ++previewRequest;
        picker.busy = true;
        const details = await git.commit(root, item.ref).catch(() => undefined);
        if (settled || request !== previewRequest) return;

        const preview = details
          ? commitPreview(details)
          : "Commit preview is unavailable";
        previewCache.set(item.ref, preview);
        setPreview(item, preview);
        picker.busy = false;
      };

      const finish = (value: string | undefined): void => {
        if (settled) return;
        settled = true;
        previewRequest += 1;
        picker.hide();
        picker.dispose();
        resolve(value);
      };

      picker.onDidChangeActive((active) => void loadPreview(active));
      picker.onDidAccept(() => {
        const selected = picker.selectedItems[0] || picker.activeItems[0];
        finish(selected?.ref);
      });
      picker.onDidHide(() => finish(undefined));
      picker.show();
      if (items.length) picker.activeItems = [items[0]];
    });
  };

  const pickCommitSearch = async (
    root: string,
    initialQuery?: string,
  ): Promise<string | undefined> => {
    return new Promise<string | undefined>((resolve) => {
      const picker = vscode.window.createQuickPick<CommitPickItem>();
      picker.placeholder = "Search commit messages (4 or more characters to start)";
      picker.prompt = "Type to search; focus a result to preview its message below";
      picker.matchOnDescription = true;
      picker.matchOnDetail = true;
      picker.keepScrollPosition = true;
      picker.ignoreFocusOut = false;

      let currentItems: CommitPickItem[] = [];
      let settled = false;
      let searchTimer: NodeJS.Timeout | undefined;
      let searchRequest = 0;
      let searchStarted = false;
      let previewRequest = 0;
      const previewCache = new Map<string, string>();

      const setPreview = (item: CommitPickItem, preview: string): void => {
        if (!currentItems.some((candidate) => candidate.ref === item.ref) || item.detail === preview) return;
        item.detail = preview;
        picker.items = [...currentItems];
      };

      const loadPreview = async (active: readonly CommitPickItem[]): Promise<void> => {
        const item = active[0];
        if (!item || settled) return;
        const cached = previewCache.get(item.ref);
        if (cached) {
          setPreview(item, cached);
          return;
        }

        const request = ++previewRequest;
        const details = await git.commit(root, item.ref).catch(() => undefined);
        if (settled || request !== previewRequest) return;
        const preview = details ? commitPreview(details) : "Commit preview is unavailable";
        previewCache.set(item.ref, preview);
        setPreview(item, preview);
      };

      const makeItems = (commits: CommitSummary[]): CommitPickItem[] => commits.map((commit) => ({
        label: `$(git-commit) ${commit.shortHash} ${commit.subject}`,
        description: `${commit.author} · ${dateLabel(commit.date)}`,
        detail: "Focus this commit to preview its full message",
        ref: commit.hash,
        commit,
      }));

      const runSearch = async (query: string, request: number): Promise<void> => {
        let commits: CommitSummary[];
        try {
          commits = await git.log(root, {
            grep: query,
            max: vscode.workspace.getConfiguration("vvgit").get<number>("log.maxCommits", 250),
          });
        } catch {
          if (settled || request !== searchRequest) return;
          currentItems = [];
          picker.items = [];
          picker.busy = false;
          picker.prompt = "Unable to search commit messages";
          return;
        }

        if (settled || request !== searchRequest || picker.value.trim() !== query) return;
        previewRequest += 1;
        currentItems = makeItems(commits);
        picker.items = currentItems;
        picker.busy = false;
        picker.prompt = commits.length
          ? `Focus a result to preview its message · ${commits.length} match${commits.length === 1 ? "" : "es"}`
          : `No commits matched “${query}”`;
        if (currentItems.length) picker.activeItems = [currentItems[0]];
      };

      const scheduleSearch = (value: string): void => {
        if (searchTimer) clearTimeout(searchTimer);
        const query = value.trim();
        const request = ++searchRequest;
        previewRequest += 1;

        const canSearch = query.length >= SEARCH_START_LENGTH
          || (searchStarted && query.length >= SEARCH_CONTINUE_LENGTH);
        if (query.length >= SEARCH_START_LENGTH) searchStarted = true;
        if (!canSearch) {
          currentItems = [];
          picker.items = [];
          picker.activeItems = [];
          picker.busy = false;
          picker.prompt = searchStarted
            ? `Type at least ${SEARCH_CONTINUE_LENGTH} characters to continue searching`
            : `Type at least ${SEARCH_START_LENGTH} characters to search`;
          return;
        }

        currentItems = [];
        picker.items = [];
        picker.activeItems = [];
        picker.busy = true;
        picker.prompt = `Searching commit messages for “${query}”…`;
        searchTimer = setTimeout(() => {
          searchTimer = undefined;
          void runSearch(query, request);
        }, 180);
      };

      const finish = (value: string | undefined): void => {
        if (settled) return;
        settled = true;
        if (searchTimer) clearTimeout(searchTimer);
        searchRequest += 1;
        previewRequest += 1;
        picker.hide();
        picker.dispose();
        resolve(value);
      };

      picker.onDidChangeValue(scheduleSearch);
      picker.onDidChangeActive((active) => void loadPreview(active));
      picker.onDidAccept(() => {
        const selected = picker.selectedItems[0] || picker.activeItems[0];
        finish(selected?.ref);
      });
      picker.onDidHide(() => finish(undefined));
      picker.show();
      const query = initialQuery?.trim() || "";
      if (query) {
        picker.value = query;
        scheduleSearch(query);
      } else {
        picker.prompt = `Type at least ${SEARCH_START_LENGTH} characters to search`;
      }
    });
  };

  const showCommit = async (root: string, revision: string): Promise<void> => {
    const details: CommitDetails = await git.commit(root, revision);
    const stat = await git.commitStat(root, revision).catch(() => "");
    output.clear();
    output.appendLine("VV Git · commit message");
    output.appendLine("─".repeat(72));
    output.appendLine(`commit ${details.hash || revision}`);
    output.appendLine(`Author: ${details.author}${details.email ? ` <${details.email}>` : ""}`);
    output.appendLine(`Date:   ${dateLabel(details.date)}`);
    output.appendLine("");
    output.appendLine(details.body || details.subject || "(no commit message)");
    if (stat.trim()) {
      output.appendLine("");
      output.appendLine("Files changed");
      output.appendLine("─".repeat(72));
      output.append(stat.trimEnd());
      output.appendLine("");
    }
    output.show(true);
  };

  const showCommitMessage = async (revision?: unknown): Promise<void> => {
    const root = await repositoryRoot();
    const selected = typeof revision === "string" && revision.trim()
      ? revision.trim()
      : await pickReference(root, "Select a commit or type a Git reference");
    if (!selected) return;
    await showCommit(root, selected);
  };

  const showBlame = async (resource?: vscode.Uri): Promise<void> => {
    const target = await fileTarget(resource);
    if (!target) return;
    if (fileBlame.isShowing(target.document)) {
      fileBlame.clear();
      vscode.window.showInformationMessage("VV Git file blame disabled for this file.");
      return;
    }
    const editor = vscode.window.visibleTextEditors.find(
      (candidate) => candidate.document.uri.toString() === target.document.uri.toString(),
    ) || await vscode.window.showTextDocument(target.document, { preview: false });
    await fileBlame.open(editor, target.root, target.relativePath);
  };

  const openDiffDocument = async (
    content: string,
    title: string,
    displayName?: string,
  ): Promise<void> => {
    const uri = documents.diffUri(content, displayName);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.languages.setTextDocumentLanguage(document, "diff");
    await vscode.window.showTextDocument(document, { preview: false });
    output.appendLine(`${title} (${content.split(/\r?\n/).length} lines)`);
  };

  const pickCommitFile = async (
    files: CommitFile[],
    placeholder: string,
  ): Promise<CommitFile | undefined> => {
    const items: CommitFilePickItem[] = files.map((file) => ({
      label: `$(file-code) ${file.path}`,
      description: [
        file.status,
        file.previousPath ? `from ${file.previousPath}` : undefined,
      ].filter(Boolean).join(" · "),
      detail: "Enter to open this file's patch",
      file,
    }));
    return new Promise<CommitFile | undefined>((resolve) => {
      const picker = vscode.window.createQuickPick<CommitFilePickItem>();
      picker.items = items;
      picker.placeholder = placeholder;
      picker.matchOnDescription = true;
      picker.matchOnDetail = true;
      picker.ignoreFocusOut = false;
      let settled = false;
      const finish = (value: CommitFile | undefined): void => {
        if (settled) return;
        settled = true;
        picker.hide();
        picker.dispose();
        resolve(value);
      };
      picker.onDidAccept(() => finish(picker.selectedItems[0]?.file || picker.activeItems[0]?.file));
      picker.onDidHide(() => finish(undefined));
      picker.show();
    });
  };

  const showCommitFiles = async (root: string, revision: string): Promise<void> => {
    const files = await git.commitFiles(root, revision);
    if (!files.length) {
      vscode.window.showInformationMessage(`No changed files were found for ${revision}.`);
      return;
    }
    output.clear();
    output.appendLine(`VV Git · changed files · ${revision}`);
    output.appendLine("─".repeat(72));
    for (const file of files) {
      output.appendLine(`${file.status.padEnd(5)} ${commitFileLabel(file)}`);
    }
    output.show(true);
  };

  const showCommitPatch = async (
    root: string,
    revision: string,
    file?: CommitFile,
  ): Promise<void> => {
    const patch = await git.commitPatch(root, revision, file?.path);
    if (!patch.trim()) {
      vscode.window.showInformationMessage(
        file ? `No patch was found for ${file.path}.` : `No patch was found for ${revision}.`,
      );
      return;
    }
    const suffix = file ? ` · ${file.path}` : " · all files";
    await openDiffDocument(
      patch,
      `VV Git · ${revision.slice(0, 10)}${suffix}`,
      file ? `${file.path}_diff` : undefined,
    );
  };

  const showCommitPatches = async (root: string, revision: string): Promise<void> => {
    const files = await git.commitFiles(root, revision);
    if (!files.length) {
      vscode.window.showInformationMessage(`No changed files were found for ${revision}.`);
      return;
    }

    let opened = 0;
    const skipped: string[] = [];
    for (const file of files) {
      const patch = await git.commitPatch(root, revision, file.path).catch(() => "");
      if (!patch.trim()) {
        skipped.push(file.path);
        continue;
      }
      await openDiffDocument(
        patch,
        `VV Git · ${revision.slice(0, 10)} · ${file.path}`,
        `${file.path}_diff`,
      );
      opened += 1;
    }

    if (!opened) {
      vscode.window.showInformationMessage(`No file patches were found for ${revision}.`);
      return;
    }
    if (skipped.length) {
      vscode.window.showWarningMessage(
        `Opened ${opened} file patch${opened === 1 ? "" : "es"}; skipped ${skipped.join(", ")}.`,
      );
    } else {
      vscode.window.showInformationMessage(
        `Opened ${opened} individual file patch${opened === 1 ? "" : "es"}.`,
      );
    }
  };

  const showCommitActions = async (root: string, revision: string): Promise<void> => {
    const details = await git.commit(root, revision);
    const stat = await git.commitStat(root, revision).catch(() => "");
    const statText = singleLine(stat, 220);
    const items: CommitActionPickItem[] = [
      {
        label: "$(comment-discussion) Show commit message and stats",
        description: "Open the commit message in the VV Git output channel",
        detail: commitPreview(details),
        action: "message",
      },
      {
        label: "$(diff) Show full commit patch",
        description: "Open the patch for every changed file",
        detail: statText || "No file statistics available",
        action: "patch",
      },
      {
        label: "$(file-code) Show patch for one file",
        description: "Choose one changed file and open its patch",
        detail: "Select a file after pressing Enter",
        action: "filePatch",
      },
      {
        label: "$(diff) Show patch for all files",
        description: "Open one diff document per changed file",
        detail: "Each tab is named <original filename>_diff",
        action: "allPatches",
      },
      {
        label: "$(list-unordered) Show changed files",
        description: "List file status and rename information",
        detail: "Open the file list in the VV Git output channel",
        action: "files",
      },
      {
        label: "$(git-merge) Squash to branch",
        description: "Merge this commit and all earlier commits into a local target",
        detail: "Choose a target branch and create one squash commit",
        action: "squash",
      },
      {
        label: "$(copy) Copy commit hash",
        description: details.hash || revision,
        detail: "Copy the full commit SHA to the clipboard",
        action: "copyHash",
      },
    ];

    const action = await new Promise<CommitAction | undefined>((resolve) => {
      const picker = vscode.window.createQuickPick<CommitActionPickItem>();
      picker.items = items;
      picker.title = `VV Git · ${details.shortHash || revision.slice(0, 10)}`;
      picker.placeholder = "Choose what to inspect for this commit";
      picker.matchOnDescription = true;
      picker.matchOnDetail = true;
      picker.ignoreFocusOut = false;
      let settled = false;
      const finish = (value: CommitAction | undefined): void => {
        if (settled) return;
        settled = true;
        picker.hide();
        picker.dispose();
        resolve(value);
      };
      picker.onDidAccept(() => finish(picker.selectedItems[0]?.action || picker.activeItems[0]?.action));
      picker.onDidHide(() => finish(undefined));
      picker.show();
    });

    switch (action) {
      case "message":
        await showCommit(root, revision);
        break;
      case "patch":
        await showCommitPatch(root, revision);
        break;
      case "filePatch": {
        const files = await git.commitFiles(root, revision);
        if (!files.length) {
          vscode.window.showInformationMessage(`No changed files were found for ${revision}.`);
          break;
        }
        const file = await pickCommitFile(files, `Select a file changed by ${details.shortHash || revision}`);
        if (file) await showCommitPatch(root, revision, file);
        break;
      }
      case "allPatches":
        await showCommitPatches(root, revision);
        break;
      case "files":
        await showCommitFiles(root, revision);
        break;
      case "squash":
        await squashCommitToBranch(revision);
        break;
      case "copyHash":
        await vscode.env.clipboard.writeText(details.hash || revision);
        vscode.window.showInformationMessage(`Copied commit ${details.shortHash || revision}.`);
        break;
    }
  };

  const showFileDiff = async (resource?: vscode.Uri): Promise<void> => {
    const target = await fileTarget(resource);
    if (!target) return;
    const tracked = await git.isTracked(target.root, target.relativePath);
    let diff = "";
    try {
      diff = await git.diff(target.root, "HEAD", undefined, target.relativePath);
    } catch (error) {
      if (tracked) throw error;
    }
    if (tracked && !diff.trim()) {
      vscode.window.showInformationMessage(`${target.relativePath} has no changes compared with HEAD.`);
      return;
    }

    const base = documents.refUri(target.root, "HEAD", target.relativePath);
    const worktree = documents.worktreeUri(target.root, target.relativePath);
    await vscode.commands.executeCommand(
      "vscode.diff",
      base,
      worktree,
      `VV Git: ${target.relativePath} · HEAD ↔ working tree`,
      { preview: false },
    );
  };

  const showRepositoryDiff = async (): Promise<void> => {
    const root = await repositoryRoot();
    const chunks: string[] = [];
    try {
      const tracked = await git.diff(root, "HEAD");
      if (tracked.trim()) chunks.push(tracked.trimEnd());
    } catch {
      // An empty repository has no HEAD; untracked files are handled below.
    }
    for (const file of await git.untrackedFiles(root)) {
      const untracked = await git.diffNoIndex(root, file).catch(() => "");
      if (untracked.trim()) chunks.push(untracked.trimEnd());
    }
    const content = chunks.join("\n\n");
    if (!content.trim()) {
      vscode.window.showInformationMessage("The Git working tree is clean.");
      return;
    }
    await openDiffDocument(content, "VV Git · working tree diff");
  };

  const compareRefs = async (left: string, right: string, root: string, title: string): Promise<void> => {
    if (left === right) {
      vscode.window.showInformationMessage("Choose two different Git references.");
      return;
    }
    const diff = await git.diff(root, left, right);
    if (!diff.trim()) {
      vscode.window.showInformationMessage(`${left} and ${right} have no differences.`);
      return;
    }
    await openDiffDocument(diff, `${title}: ${left} ↔ ${right}`);
  };

  const compareCommits = async (leftArg?: unknown, rightArg?: unknown): Promise<void> => {
    const root = await repositoryRoot();
    const left = typeof leftArg === "string" && leftArg.trim()
      ? leftArg.trim()
      : await pickReference(root, "Select the older/left commit or reference");
    if (!left) return;
    const right = typeof rightArg === "string" && rightArg.trim()
      ? rightArg.trim()
      : await pickReference(root, "Select the newer/right commit or reference");
    if (!right) return;
    await compareRefs(left, right, root, "VV Git · compare");
  };

  const compareBranches = async (): Promise<void> => {
    const root = await repositoryRoot();
    const left = await pickBranch(root, "Select the first branch to compare");
    if (!left) return;
    const right = await pickBranch(root, "Select the second branch to compare");
    if (!right) return;
    await compareRefs(left, right, root, "VV Git · branch compare");
  };

  const searchLog = async (initialQuery?: unknown): Promise<void> => {
    const root = await repositoryRoot();
    const query = typeof initialQuery === "string" ? initialQuery : undefined;
    const selected = await pickCommitSearch(root, query);
    if (selected) await showCommitActions(root, selected);
  };

  const showBranchLog = async (): Promise<void> => {
    const root = await repositoryRoot();
    const branch = await pickBranch(root, "Select a branch to browse");
    if (!branch) return;
    const commits = await git.log(root, {
      ref: branch,
      max: vscode.workspace.getConfiguration("vvgit").get<number>("log.maxCommits", 250),
    });
    if (!commits.length) {
      vscode.window.showInformationMessage(`${branch} has no commits.`);
      return;
    }
    const selected = await pickCommitFromList(root, commits, `Commits on ${branch}`);
    if (selected) await showCommitActions(root, selected);
  };

  const leaveMergeConflictForUser = async (
    root: string,
    source: string,
    target: string,
    squash: boolean,
  ): Promise<boolean> => {
    if (!(await git.hasConflicts(root).catch(() => false))) return false;
    const completion = squash
      ? "Resolve the conflicts, stage the files, and commit the squash result, or reset the target branch manually."
      : "Resolve the conflicts and complete the merge, or abort it manually.";
    output.appendLine(`Merge conflict while applying ${source} into ${target}.`);
    output.appendLine(completion);
    output.show(true);
    await refreshBranchStatus();
    vscode.window.showErrorMessage(`Merge conflict while applying ${source} into ${target}. ${completion}`);
    return true;
  };

  const squashCommitToBranch = async (revisionArg?: unknown): Promise<void> => {
    const root = await repositoryRoot();
    const revision = typeof revisionArg === "string" && revisionArg.trim()
      ? revisionArg.trim()
      : await pickReference(root, "Select the commit to squash into a branch");
    if (!revision) return;
    if (/^0+$/.test(revision)) {
      vscode.window.showInformationMessage("An uncommitted line cannot be squashed to a branch.");
      return;
    }

    const selectedHash = await git.resolveCommit(root, revision);
    const selectedCommit = await git.commit(root, selectedHash);
    const localBranches = (await git.branches(root)).filter((branch) => !branch.isRemote);
    if (!localBranches.length) {
      vscode.window.showInformationMessage("Squash to branch needs a local target branch.");
      return;
    }

    const target = await pickBranch(root, "Select the local target branch for the squash", true);
    if (!target) return;
    const ahead = await git.commitsAhead(root, target, selectedHash);
    if (ahead < 1) {
      vscode.window.showInformationMessage(
        `${selectedCommit.shortHash || selectedHash.slice(0, 10)} has no commits ahead of ${target}.`,
      );
      return;
    }

    const commitMessage = await vscode.window.showInputBox({
      prompt: `Commit message for squashing history through ${selectedCommit.shortHash || selectedHash.slice(0, 10)} into ${target}`,
      value: selectedCommit.subject,
      placeHolder: `Squash history through ${selectedCommit.shortHash || selectedHash.slice(0, 10)}`,
      ignoreFocusOut: true,
    });
    if (commitMessage === undefined || !commitMessage.trim()) return;

    const confirmation = await vscode.window.showWarningMessage(
      `Squash ${ahead} commit(s) through ${selectedCommit.shortHash || selectedHash.slice(0, 10)} into ${target}?`,
      {
        modal: true,
        detail: "This includes the selected commit and all earlier commits not already in the target branch.",
      },
      "Squash to branch",
    );
    if (confirmation !== "Squash to branch") return;

    const status = await git.status(root);
    if (status.trim()) {
      throw new Error("The working tree is not clean. Commit or stash changes before a squash merge.");
    }
    const operation = await git.operationInProgress(root);
    if (operation) {
      throw new Error(`A Git ${operation} is already in progress. Finish or abort it before a squash merge.`);
    }

    const targetHead = await git.resolveCommit(root, target);
    const originalBranch = await git.currentBranch(root);
    const originalRef = originalBranch || await git.headHash(root);
    let mergeStarted = false;
    let committed = false;
    let targetCheckedOut = originalBranch === target;

    try {
      if (!targetCheckedOut) {
        await git.checkout(root, target);
        targetCheckedOut = true;
      }
      mergeStarted = true;
      await git.mergeSquash(root, selectedHash);
      await git.createCommit(root, commitMessage.trim());
      committed = true;
    } catch (error) {
      if (await leaveMergeConflictForUser(root, selectedHash, target, true)) return;
      if (!committed && mergeStarted) {
        await git.resetHard(root, targetHead).catch(() => undefined);
      }
      if (!committed && targetCheckedOut && originalRef && originalBranch !== target) {
        await git.checkout(root, originalRef).catch(() => undefined);
      }
      throw error;
    }

    const newHead = await git.headHash(root);
    output.appendLine(`Squash merged history through ${selectedHash} into ${target}`);
    output.appendLine(`Commit: ${newHead}`);
    output.show(true);
    await refreshBranchStatus();
    vscode.window.showInformationMessage(
      `Squash merged history through ${selectedCommit.shortHash || selectedHash.slice(0, 10)} into ${target}.`,
    );
  };

  const mergeBranchToBranch = async (): Promise<void> => {
    const root = await repositoryRoot();
    const localBranches = (await git.branches(root)).filter((branch) => !branch.isRemote);
    if (!localBranches.length) {
      vscode.window.showInformationMessage("A branch merge needs at least one local target branch.");
      return;
    }

    // The target must be local because VV Git checks it out and commits on it;
    // the source may also be a remote-tracking branch.
    const source = await pickBranch(root, "Select the source branch to merge");
    if (!source) return;
    const target = await pickBranch(root, "Select the local target branch to receive the merge", true);
    if (!target) return;
    if (source === target) {
      vscode.window.showErrorMessage("Source and target branches must be different.");
      return;
    }

    const ahead = await git.commitsAhead(root, target, source);
    if (ahead < 1) {
      vscode.window.showInformationMessage(`${source} has no commits ahead of ${target}.`);
      return;
    }

    const confirmation = await vscode.window.showWarningMessage(
      `Merge ${source} into ${target}? Git will check out ${target} and create a merge commit.`,
      { modal: true },
      "Merge branches",
    );
    if (confirmation !== "Merge branches") return;

    const status = await git.status(root);
    if (status.trim()) {
      throw new Error("The working tree is not clean. Commit or stash changes before a branch merge.");
    }
    const operation = await git.operationInProgress(root);
    if (operation) {
      throw new Error(`A Git ${operation} is already in progress. Finish or abort it before a branch merge.`);
    }

    const targetHead = await git.resolveCommit(root, target);
    const originalBranch = await git.currentBranch(root);
    const originalRef = originalBranch || await git.headHash(root);
    let mergeStarted = false;
    let targetCheckedOut = originalBranch === target;

    try {
      if (!targetCheckedOut) {
        await git.checkout(root, target);
        targetCheckedOut = true;
      }
      mergeStarted = true;
      await git.merge(root, source);
    } catch (error) {
      if (await leaveMergeConflictForUser(root, source, target, false)) return;
      if (mergeStarted) {
        await git.resetHard(root, targetHead).catch(() => undefined);
      }
      if (targetCheckedOut && originalBranch !== target) {
        await git.checkout(root, originalRef).catch(() => undefined);
      }
      throw error;
    }

    const newHead = await git.headHash(root);
    output.appendLine(`Merged ${source} into ${target}`);
    output.appendLine(`Commit: ${newHead}`);
    output.show(true);
    await refreshBranchStatus();
    vscode.window.showInformationMessage(`Merged ${source} into ${target}.`);
  };

  const squashBranchToBranch = async (): Promise<void> => {
    const root = await repositoryRoot();
    const localBranches = (await git.branches(root)).filter((branch) => !branch.isRemote);
    if (!localBranches.length) {
      vscode.window.showInformationMessage("A squash merge needs at least one local target branch.");
      return;
    }

    // A remote-tracking branch is a valid source ref, while the target must be
    // local so the squash commit can be created on it.
    const source = await pickBranch(root, "Select the source branch to squash");
    if (!source) return;
    const target = await pickBranch(root, "Select the local target branch to receive the squash", true);
    if (!target) return;
    if (source === target) {
      vscode.window.showErrorMessage("Source and target branches must be different.");
      return;
    }

    const ahead = await git.commitsAhead(root, target, source);
    if (ahead < 1) {
      vscode.window.showInformationMessage(`${source} has no commits ahead of ${target}.`);
      return;
    }
    const patchFileName = `${branchFileName(source)}_TO_${branchFileName(target)}.patch`;
    const commitMessage = patchFileName;

    const configuredDirectory = vscode.workspace.getConfiguration("vvgit").get<string>("patchDirectory", "patches");
    const patchDirectory = configuredDirectory?.trim()
      ? path.isAbsolute(configuredDirectory.trim())
        ? path.normalize(configuredDirectory.trim())
        : path.resolve(root, configuredDirectory.trim())
      : root;
    const defaultPatch = path.join(patchDirectory, patchFileName);
    const defaultPatchValue = path.relative(root, defaultPatch).split(path.sep).join("/") || defaultPatch;
    const patchInput = await vscode.window.showInputBox({
      prompt: "Where should the format-patch -1 file be written?",
      value: defaultPatchValue,
      placeHolder: "patches/BIA-222_TO_dev.patch",
      ignoreFocusOut: true,
    });
    if (patchInput === undefined || !patchInput.trim()) return;
    const patchPath = path.isAbsolute(patchInput.trim())
      ? path.normalize(patchInput.trim())
      : path.resolve(root, patchInput.trim());

    if (await exists(patchPath)) {
      const overwrite = await vscode.window.showWarningMessage(
        `Patch already exists: ${patchPath}`,
        { modal: true },
        "Overwrite patch",
      );
      if (overwrite !== "Overwrite patch") return;
    }

    const confirmation = await vscode.window.showWarningMessage(
      `Squash ${ahead} commit(s) from ${source} into ${target}? Git will check out ${target}, create a commit, and write a format-patch -1 file.`,
      { modal: true, detail: `Commit message: ${commitMessage}\nPatch: ${patchPath}` },
      "Squash & create patch",
    );
    if (confirmation !== "Squash & create patch") return;

    const status = await git.status(root);
    if (status.trim()) {
      throw new Error("The working tree is not clean. Commit or stash changes before a squash merge.");
    }
    const operation = await git.operationInProgress(root);
    if (operation) {
      throw new Error(`A Git ${operation} is already in progress. Finish or abort it before a squash merge.`);
    }

    // Capture the source patch before changing branches. The source ref stays
    // untouched, so this is exactly `git format-patch -1 <source>`.
    const patch = await git.formatPatch(root, source);
    const targetHead = await git.resolveCommit(root, target);
    const originalBranch = await git.currentBranch(root);
    const originalRef = originalBranch || await git.headHash(root);
    let mergeStarted = false;
    let committed = false;
    let targetCheckedOut = originalBranch === target;

    try {
      if (!targetCheckedOut) {
        await git.checkout(root, target);
        targetCheckedOut = true;
      }
      mergeStarted = true;
      await git.mergeSquash(root, source);
      await git.createCommit(root, commitMessage.trim());
      committed = true;
      await writeAtomically(patchPath, patch);
    } catch (error) {
      if (await leaveMergeConflictForUser(root, source, target, true)) return;
      if (!committed && mergeStarted) {
        await git.resetHard(root, targetHead).catch(() => undefined);
      }
      if (!committed && targetCheckedOut && originalRef && originalBranch !== target) {
        await git.checkout(root, originalRef).catch(() => undefined);
      }
      if (committed) {
        throw new Error(`Squash commit was created, but the patch could not be written to ${patchPath}: ${shortError(error)}`);
      }
      throw error;
    }

    const newHead = await git.headHash(root);
    output.appendLine(`Squash merged ${source} into ${target}`);
    output.appendLine(`Commit: ${newHead}`);
    output.appendLine(`Commit message: ${commitMessage}`);
    output.appendLine(`Patch:  ${patchPath}`);
    output.show(true);
    await refreshBranchStatus();
    const action = await vscode.window.showInformationMessage(
      `Squash merged ${source} into ${target}; patch created.`,
      "Open patch",
    );
    if (action === "Open patch") {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(patchPath));
      await vscode.window.showTextDocument(document, { preview: false });
    }
  };

  const refreshBranchStatus = async (): Promise<void> => {
    try {
      const root = await repositoryRoot();
      const branch = await git.currentBranch(root);
      if (!branch) {
        branchStatus.hide();
        return;
      }
      branchStatus.text = `$(git-branch) ${branch}`;
      branchStatus.show();
    } catch {
      branchStatus.hide();
    }
  };

  const register = (
    command: string,
    action: string,
    handler: (...args: any[]) => Promise<void> | void,
  ): void => {
    context.subscriptions.push(vscode.commands.registerCommand(command, (...args: any[]) => {
      try {
        return Promise.resolve(handler(...args)).catch((error) => showCommandError(action, error));
      } catch (error) {
        showCommandError(action, error);
        return undefined;
      }
    }));
  };

  register("vvgit.toggleInlineBlame", "Unable to toggle inline blame", async () => {
    const enabled = await blame.toggle();
    vscode.window.showInformationMessage(`VV Git inline blame ${enabled ? "enabled" : "disabled"}.`);
  });
  register("vvgit.blameFile", "Unable to show Git blame", showBlame);
  register("vvgit.showCommitMessage", "Unable to show commit message", showCommitMessage);
  register("vvgit.showDiff", "Unable to show file diff", showFileDiff);
  register("vvgit.showRepositoryDiff", "Unable to show repository diff", showRepositoryDiff);
  register("vvgit.searchLog", "Unable to search commit messages", searchLog);
  register("vvgit.showBranchLog", "Unable to show branch log", showBranchLog);
  register("vvgit.compareCommits", "Unable to compare Git references", compareCommits);
  register("vvgit.compareBranches", "Unable to compare branches", compareBranches);
  register("vvgit.mergeBranchToBranch", "Unable to merge branches", mergeBranchToBranch);
  register("vvgit.squashBranchToBranch", "Unable to squash branches", squashBranchToBranch);
  register("vvgit.squashCommitToBranch", "Unable to squash commit to branch", squashCommitToBranch);
  register("vvgit.showBranches", "Unable to browse branches", showBranchLog);
  register("vvgit.refreshBlame", "Unable to refresh blame", async () => {
    await blame.refresh(vscode.window.activeTextEditor);
    await fileBlame.refresh();
  });

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => void refreshBranchStatus()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void refreshBranchStatus()),
  );
  void refreshBranchStatus();
}

export function deactivate(): void {}
