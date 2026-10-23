import * as vscode from "vscode";
import { BlameLine, CommitDetails, GitService } from "./git";

interface BlameCacheEntry {
  version: number;
  root: string;
  relativePath: string;
  lines: BlameLine[];
}

interface CommitHoverInfo {
  details?: CommitDetails;
  stat?: string;
  parent?: string;
  patch?: string;
}

interface BlameDiffHunk {
  header: string;
  body: string[];
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  oldLines: string[];
  newLines: string[];
}

interface BlameRestoreArgs {
  root: string;
  relativePath: string;
  commit: string;
  lineNumber: number;
  originalLine: number;
  sectionEndOriginalLine: number;
}

const MAX_HOVER_DIFF_LINES = 10;
// Git's well-known empty tree lets root commits use the empty file as their
// previous version, so their blame hovers can show and restore the initial
// section as well.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const TRUSTED_COMMANDS = [
  "vvgit.showCommitPatch",
  "vvgit.showCommitDiffByFile",
  "vvgit.showDiff",
  "vvgit.restoreBlameSection",
  "vvgit.compareCommits",
  "vvgit.searchLog",
  "vvgit.blameFile",
  "vvgit.showBranches",
  "vvgit.mergeBranchToBranch",
  "vvgit.squashBranchToBranch",
  "vvgit.squashCommitToBranch",
];

const MAX_SMALL_INTEGER = 2 ** 30 - 1;

function cssInjection(styles: Record<string, string | undefined>): string {
  const textDecoration = styles["text-decoration"] || "none";
  return `text-decoration:${textDecoration};${Object.entries(styles)
    .filter(([key, value]) => key !== "text-decoration" && value)
    .map(([key, value]) => `${key}:${value}`)
    .join(";")};`;
}

function lineStartRange(lineNumber: number): vscode.Range {
  // GitLens anchors `before` decorations at the start of a line. VS Code
  // accepts this zero-width range in practice and it keeps the source text
  // itself completely untouched.
  return new vscode.Range(lineNumber, 0, lineNumber, 0);
}

function lineEndRange(lineNumber: number): vscode.Range {
  // A large character position is clamped to the end of the line by VS Code,
  // which keeps an `after` attachment at the visual end of short and empty
  // lines alike.
  return new vscode.Range(lineNumber, MAX_SMALL_INTEGER, lineNumber, MAX_SMALL_INTEGER);
}

function fileBlameBefore(separator: boolean): vscode.ThemableDecorationAttachmentRenderOptions {
  return {
    backgroundColor: new vscode.ThemeColor("vvgit.fileBlameBackground"),
    color: new vscode.ThemeColor("vvgit.fileBlameForeground"),
    fontStyle: "normal",
    fontWeight: "normal",
    height: "100%",
    margin: "0 26px -1px 0",
    width: "360px",
    textDecoration: cssInjection({
      "text-decoration": separator ? "overline solid rgba(0, 0, 0, .2)" : undefined,
      "box-sizing": "border-box",
      "padding": "0 4px",
      "font-family": "var(--vscode-editor-font-family)",
      "font-size": "var(--vscode-editor-font-size)",
      "white-space": "pre",
      "font-variant-numeric": "tabular-nums",
      "overflow": "hidden",
      "text-overflow": "ellipsis",
    }),
  };
}

function isUncommitted(commit: string): boolean {
  return /^0+$/.test(commit) || commit.length === 0;
}

function markdownText(value: string): string {
  return value.replace(/[\\`*_[\]<>]/g, "\\$&");
}

function hunkHeader(line: string): RegExpExecArray | undefined {
  return /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line) || undefined;
}

function parseDiffHunks(patch: string): BlameDiffHunk[] {
  const lines = patch.split(/\r?\n/);
  const hunks: BlameDiffHunk[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = hunkHeader(lines[index]);
    if (!match) continue;

    const body: string[] = [];
    let cursor = index + 1;
    while (cursor < lines.length && !hunkHeader(lines[cursor])) {
      const line = lines[cursor];
      if (line.startsWith("diff --git ")) break;
      if (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-") || line.startsWith("\\")) {
        body.push(line);
        cursor += 1;
        continue;
      }
      break;
    }

    const oldLines: string[] = [];
    const newLines: string[] = [];
    for (const line of body) {
      if (line.startsWith(" ") || line.startsWith("-")) oldLines.push(line.slice(1));
      if (line.startsWith(" ") || line.startsWith("+")) newLines.push(line.slice(1));
    }

    hunks.push({
      header: lines[index],
      body,
      oldStart: Number(match[1]),
      oldCount: Number(match[2] || 1),
      newStart: Number(match[3]),
      newCount: Number(match[4] || 1),
      oldLines,
      newLines,
    });
    index = cursor - 1;
  }
  return hunks;
}

function hunkForLine(patch: string | undefined, oneBasedLine: number): BlameDiffHunk | undefined {
  if (!patch) return undefined;
  return parseDiffHunks(patch).find((hunk) => (
    hunk.newCount > 0
    && oneBasedLine >= hunk.newStart
    && oneBasedLine < hunk.newStart + hunk.newCount
  ));
}

interface HunkLine {
  text: string;
  oldLine?: number;
  newLine?: number;
}

function hunkLines(hunk: BlameDiffHunk): HunkLine[] {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  return hunk.body.map((text) => {
    const line: HunkLine = { text };
    if (text.startsWith(" ")) {
      line.oldLine = oldLine;
      line.newLine = newLine;
      oldLine += 1;
      newLine += 1;
    } else if (text.startsWith("-")) {
      line.oldLine = oldLine;
      oldLine += 1;
    } else if (text.startsWith("+")) {
      line.newLine = newLine;
      newLine += 1;
    }
    return line;
  });
}

function hunkLineIndex(hunk: BlameDiffHunk, oneBasedLine: number): number {
  const lines = hunkLines(hunk);
  const exact = lines.findIndex((line) => line.newLine === oneBasedLine);
  if (exact >= 0) return exact;
  return lines.findIndex((line) => line.newLine !== undefined && line.newLine > oneBasedLine);
}

function offsetsBefore(hunk: BlameDiffHunk, index: number): { oldLine: number; newLine: number } {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  for (const line of hunk.body.slice(0, index)) {
    if (line.startsWith(" ") || line.startsWith("-")) oldLine += 1;
    if (line.startsWith(" ") || line.startsWith("+")) newLine += 1;
  }
  return { oldLine, newLine };
}

function hunkLineEndIndex(
  hunk: BlameDiffHunk,
  start: number,
  endOneBasedLine?: number,
): number {
  if (endOneBasedLine === undefined) return hunk.body.length;
  const lines = hunkLines(hunk);
  let end = start;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.newLine !== undefined) {
      if (line.newLine > endOneBasedLine) break;
      end = index + 1;
    } else if (line.text.startsWith("-") && end > start) {
      // Keep deletions attached to the preceding focused replacement.
      end = index + 1;
    }
  }
  return end;
}

function deletionPreludeStart(hunk: BlameDiffHunk, start: number): number {
  let result = start;
  while (result > 0 && hunk.body[result - 1].startsWith("-")) result -= 1;
  return result;
}

function sectionForLine(
  hunk: BlameDiffHunk,
  oneBasedLine: number,
  endOneBasedLine?: number,
): BlameDiffHunk | undefined {
  const displayStart = hunkLineIndex(hunk, oneBasedLine);
  if (displayStart < 0) return undefined;

  // Include deletions immediately before the focused new line when applying
  // the previous code, otherwise a removed line would never be restored.
  const applyStart = deletionPreludeStart(hunk, displayStart);
  const sectionEnd = hunkLineEndIndex(hunk, displayStart, endOneBasedLine);
  const applyEnd = Math.min(sectionEnd, displayStart + MAX_HOVER_DIFF_LINES);
  const body = hunk.body.slice(applyStart, applyEnd);
  const offsets = offsetsBefore(hunk, applyStart);
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const line of body) {
    if (line.startsWith(" ") || line.startsWith("-")) oldLines.push(line.slice(1));
    if (line.startsWith(" ") || line.startsWith("+")) newLines.push(line.slice(1));
  }
  if (!newLines.length) return undefined;

  return {
    header: hunk.header,
    body,
    oldStart: offsets.oldLine,
    oldCount: oldLines.length,
    newStart: offsets.newLine,
    newCount: newLines.length,
    oldLines,
    newLines,
  };
}

function diffPreview(
  hunk: BlameDiffHunk,
  oneBasedLine: number,
  endOneBasedLine?: number,
): { text: string; truncated: boolean; omitted: number } {
  const displayStart = hunkLineIndex(hunk, oneBasedLine);
  if (displayStart < 0) return { text: "", truncated: false, omitted: 0 };
  const start = deletionPreludeStart(hunk, displayStart);
  const sectionEnd = hunkLineEndIndex(hunk, displayStart, endOneBasedLine);
  const lines = hunk.body.slice(start, Math.min(sectionEnd, displayStart + MAX_HOVER_DIFF_LINES));
  if (lines.length <= MAX_HOVER_DIFF_LINES) {
    return { text: lines.join("\n"), truncated: false, omitted: 0 };
  }

  const kept = Math.max(1, MAX_HOVER_DIFF_LINES - 1);
  const omitted = lines.length - kept;
  return {
    text: [...lines.slice(0, kept), `… ${omitted} more diff line${omitted === 1 ? "" : "s"} omitted`].join("\n"),
    truncated: true,
    omitted,
  };
}

function restoreArgs(value: unknown): BlameRestoreArgs | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<BlameRestoreArgs>;
  if (
    typeof candidate.root !== "string"
    || typeof candidate.relativePath !== "string"
    || typeof candidate.commit !== "string"
    || typeof candidate.lineNumber !== "number"
    || !Number.isInteger(candidate.lineNumber)
    || typeof candidate.originalLine !== "number"
    || !Number.isInteger(candidate.originalLine)
    || typeof candidate.sectionEndOriginalLine !== "number"
    || !Number.isInteger(candidate.sectionEndOriginalLine)
  ) return undefined;
  return {
    root: candidate.root,
    relativePath: candidate.relativePath,
    commit: candidate.commit,
    lineNumber: candidate.lineNumber,
    originalLine: candidate.originalLine,
    sectionEndOriginalLine: candidate.sectionEndOriginalLine,
  };
}

function sameLines(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && actual.every((line, index) => line === expected[index]);
}

function blameSectionEnd(lines: BlameLine[], line: BlameLine): number {
  let index = line.lineNumber;
  while (index + 1 < lines.length && lines[index + 1].commit === line.commit) index += 1;
  return lines[index]?.originalLine ?? line.originalLine;
}

function ordinal(value: number): string {
  if (value % 100 >= 11 && value % 100 <= 13) return `${value}th`;
  switch (value % 10) {
    case 1: return `${value}st`;
    case 2: return `${value}nd`;
    case 3: return `${value}rd`;
    default: return `${value}th`;
  }
}

function relativeDate(timestamp?: number): string {
  if (timestamp === undefined || !Number.isFinite(timestamp)) return "unknown date";
  const seconds = Math.round((Date.now() - timestamp * 1_000) / 1_000);
  const future = seconds < 0;
  const value = Math.abs(seconds);
  const units: Array<[number, string]> = [
    [60 * 60 * 24 * 365, "y"],
    [60 * 60 * 24 * 30, "mo"],
    [60 * 60 * 24 * 7, "w"],
    [60 * 60 * 24, "d"],
    [60 * 60, "h"],
    [60, "m"],
  ];
  const unit = units.find(([size]) => value >= size);
  if (!unit) return future ? "in a moment" : "just now";
  const amount = Math.max(1, Math.floor(value / unit[0]));
  if (unit[1] === "d" && amount === 1) return future ? "tomorrow" : "yesterday";
  return future ? `in ${amount}${unit[1]}` : `${amount}${unit[1]} ago`;
}

export function blameDate(timestamp?: number): string {
  const format = vscode.workspace.getConfiguration("vvgit.blame").get<string>("dateFormat", "relative");
  if (timestamp === undefined || !Number.isFinite(timestamp)) return "unknown date";
  const date = new Date(timestamp * 1_000);
  if (format === "iso") return date.toISOString().replace(/\.\d{3}Z$/, "Z");
  if (format === "short") {
    const pad = (value: number): string => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }
  return relativeDate(timestamp);
}

export function blameFullDate(timestamp?: number): string {
  if (timestamp === undefined || !Number.isFinite(timestamp)) return "unknown date";
  const date = new Date(timestamp * 1_000);
  const month = date.toLocaleString([], { month: "long" });
  const time = date.toLocaleString([], { hour: "numeric", minute: "2-digit" });
  return `${month} ${ordinal(date.getDate())}, ${date.getFullYear()} at ${time}`;
}

export function blameAuthor(line: BlameLine): string {
  if (isUncommitted(line.commit)) return "Not committed yet";
  return line.author || "Unknown author";
}

function commandLink(command: string, args: unknown[], label: string): string {
  const uri = `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;
  // Escape the brackets inside the Markdown link label so the rendered hover
  // visibly shows each action as `[Diff]`, `[Merge]`, and so on.
  return `[\\[${label}\\]](${uri})`;
}

function commitActions(line: BlameLine): string {
  const actions = [
    commandLink("vvgit.showDiff", [], "Diff"),
    commandLink("vvgit.blameFile", [], "File blame"),
    commandLink("vvgit.showBranches", [], "Branches"),
    commandLink("vvgit.mergeBranchToBranch", [], "Merge"),
  ];

  if (!isUncommitted(line.commit)) {
    actions.push(commandLink("vvgit.squashCommitToBranch", [line.commit], "Squash to branch"));
    actions.unshift(
      commandLink("vvgit.showCommitPatch", [line.commit], "Commit patch"),
      commandLink("vvgit.showCommitDiffByFile", [line.commit], "Diff by file"),
      commandLink("vvgit.compareCommits", [line.commit], "Compare"),
      commandLink("vvgit.searchLog", [line.summary], "Search"),
    );
  }

  return actions.join("  ");
}

function statSummary(stat: string | undefined): string | undefined {
  if (!stat) return undefined;
  return stat
    .split(/\r?\n/)
    .map((line) => line.trim())
    .reverse()
    .find((line) => /\d+ files? changed/.test(line));
}

async function loadParentPatch(
  git: GitService,
  root: string,
  relativePath: string,
  commit: string,
): Promise<{ parent: string; patch: string } | undefined> {
  const parent = await git.resolveCommit(root, `${commit}^`).catch(() => EMPTY_TREE);
  const patch = await git.diff(root, parent, commit, relativePath).catch(() => "");
  return patch.trim() ? { parent, patch } : undefined;
}

async function makeBlameHover(
  git: GitService,
  hoverCache: Map<string, Promise<CommitHoverInfo>>,
  cache: BlameCacheEntry,
  document: vscode.TextDocument,
  position: vscode.Position,
  line: BlameLine,
): Promise<vscode.Hover> {
  const sourceText = document.lineAt(position.line).text;
  const markdown = new vscode.MarkdownString();
  const author = line.authorMail
    ? `${blameAuthor(line)} · ${line.authorMail}`
    : blameAuthor(line);
  markdown.appendMarkdown(`**${markdownText(author)}** · ${markdownText(blameDate(line.authorTime))} (${markdownText(blameFullDate(line.authorTime))})\n\n`);

  if (isUncommitted(line.commit)) {
    markdown.appendMarkdown("**Working tree change**\n\n");
    markdown.appendMarkdown("This line is not part of a commit yet.\n\n");
    markdown.appendMarkdown(commitActions(line));
    markdown.isTrusted = { enabledCommands: TRUSTED_COMMANDS };
    return new vscode.Hover(markdown, new vscode.Range(position.line, 0, position.line, sourceText.length));
  }

  const key = `${cache.root}\u0000${cache.relativePath}\u0000${line.commit}`;
  let infoPromise = hoverCache.get(key);
  if (!infoPromise) {
    infoPromise = Promise.all([
      git.commit(cache.root, line.commit).catch(() => undefined),
      git.commitStat(cache.root, line.commit).catch(() => undefined),
      loadParentPatch(git, cache.root, cache.relativePath, line.commit),
    ]).then(([details, stat, change]) => ({
      details,
      stat,
      parent: change?.parent,
      patch: change?.patch,
    }));
    hoverCache.set(key, infoPromise);
  }
  const info = await infoPromise;
  const details = info.details;
  const subject = details?.subject || line.summary || "(no commit message)";
  markdown.appendMarkdown(`**${markdownText(subject)}**\n\n`);

  const body = details?.body || "";
  const rest = body.split(/\r?\n/).slice(1).join("\n").trim();
  if (rest) markdown.appendText(`${rest}\n\n`);

  const shortHash = line.commit.slice(0, 10);
  markdown.appendMarkdown(`\`${shortHash}\` · ${markdownText(cache.relativePath)}\n\n`);
  const summary = statSummary(info.stat);
  if (summary) markdown.appendMarkdown(`**${markdownText(summary)}**\n\n`);

  const hunk = hunkForLine(info.patch, line.originalLine + 1);
  const sectionEndOriginalLine = blameSectionEnd(cache.lines, line);
  if (hunk && info.parent) {
    const preview = diffPreview(hunk, line.originalLine + 1, sectionEndOriginalLine + 1);
    const applySection = sectionForLine(hunk, line.originalLine + 1, sectionEndOriginalLine + 1);
    markdown.appendMarkdown(`**Changes from the previous version (line ${position.line + 1} onward)**\n\n`);
    if (preview.text) markdown.appendCodeblock(preview.text, "diff");
    if (applySection) {
      markdown.appendMarkdown(`${commandLink(
        "vvgit.restoreBlameSection",
        [{
          root: cache.root,
          relativePath: cache.relativePath,
          commit: line.commit,
          lineNumber: line.lineNumber,
          originalLine: line.originalLine,
          sectionEndOriginalLine,
        }],
        "Apply previous code",
      )}\n\n`);
    }
  }

  markdown.appendMarkdown(commitActions(line));
  markdown.isTrusted = { enabledCommands: TRUSTED_COMMANDS };
  return new vscode.Hover(markdown, new vscode.Range(position.line, 0, position.line, sourceText.length));
}

/** Shows blame only on the active cursor line and keeps a small metadata cache. */
export class InlineBlameController implements vscode.Disposable {
  private readonly decoration: vscode.TextEditorDecorationType;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly cache = new Map<string, BlameCacheEntry>();
  private readonly hoverCache = new Map<string, Promise<CommitHoverInfo>>();
  private refreshTimer: NodeJS.Timeout | undefined;
  private requestId = 0;
  private enabled: boolean;
  private lastEditor: vscode.TextEditor | undefined;

  constructor(private readonly git: GitService) {
    this.enabled = vscode.workspace.getConfiguration("vvgit").get<boolean>("inlineBlame", true);
    this.decoration = vscode.window.createTextEditorDecorationType({
      rangeBehavior: vscode.DecorationRangeBehavior.OpenOpen,
      after: {
        color: new vscode.ThemeColor("editorCodeLens.foreground"),
        fontStyle: "normal",
        fontWeight: "normal",
        margin: "0 0 0 2em",
        textDecoration: cssInjection({
          "white-space": "pre",
          "font-family": "var(--vscode-editor-font-family)",
          "font-size": "var(--vscode-editor-font-size)",
          "font-variant-numeric": "tabular-nums",
        }),
      },
    });

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (this.lastEditor && this.lastEditor !== editor) {
          this.lastEditor.setDecorations(this.decoration, []);
          this.cache.delete(this.lastEditor.document.uri.toString());
        }
        this.lastEditor = editor;
        void this.refresh(editor);
      }),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor !== vscode.window.activeTextEditor) return;
        const cached = this.cache.get(event.textEditor.document.uri.toString());
        if (cached?.version === event.textEditor.document.version) this.applyCurrentLine(event.textEditor);
        else this.scheduleRefresh();
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (this.lastEditor?.document.uri.toString() === event.document.uri.toString()) {
          this.scheduleRefresh();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("vvgit.inlineBlame") || event.affectsConfiguration("vvgit.blame")) {
          this.enabled = vscode.workspace.getConfiguration("vvgit").get<boolean>("inlineBlame", true);
          void this.refresh(vscode.window.activeTextEditor);
        }
      }),
    );

    this.lastEditor = vscode.window.activeTextEditor;
    void this.refresh(this.lastEditor);
  }

  public dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    this.requestId += 1;
    this.lastEditor?.setDecorations(this.decoration, []);
    this.decoration.dispose();
    this.cache.clear();
    this.hoverCache.clear();
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }

  public async toggle(): Promise<boolean> {
    this.enabled = !this.enabled;
    const configuration = vscode.workspace.getConfiguration("vvgit");
    const inspection = configuration.inspect<boolean>("inlineBlame");
    let target = vscode.ConfigurationTarget.Global;
    if (inspection?.workspaceFolderValue !== undefined) target = vscode.ConfigurationTarget.WorkspaceFolder;
    else if (inspection?.workspaceValue !== undefined) target = vscode.ConfigurationTarget.Workspace;

    try {
      await configuration.update("inlineBlame", this.enabled, target);
    } catch {
      // Keep the command useful in restricted/read-only settings scopes.
    }
    await this.refresh(vscode.window.activeTextEditor);
    return this.enabled;
  }

  public scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh(vscode.window.activeTextEditor);
    }, 250);
  }

  public async refresh(editor: vscode.TextEditor | undefined): Promise<void> {
    const requestId = ++this.requestId;
    if (this.lastEditor && this.lastEditor !== editor) {
      this.lastEditor.setDecorations(this.decoration, []);
      this.cache.delete(this.lastEditor.document.uri.toString());
    }
    this.lastEditor = editor;

    if (!editor || editor.document.uri.scheme !== "file" || !this.enabled) {
      editor?.setDecorations(this.decoration, []);
      if (editor) this.cache.delete(editor.document.uri.toString());
      return;
    }

    const maxLines = vscode.workspace.getConfiguration("vvgit").get<number>("blame.maxLineCount", 10_000);
    if (editor.document.lineCount > maxLines) {
      editor.setDecorations(this.decoration, []);
      this.cache.delete(editor.document.uri.toString());
      return;
    }

    try {
      const root = await this.git.repositoryRoot(editor.document.uri);
      const relativePath = this.git.relativePath(root, editor.document.uri);
      const lines = await this.git.blame(root, relativePath);
      if (requestId !== this.requestId || editor !== vscode.window.activeTextEditor) return;

      this.cache.set(editor.document.uri.toString(), {
        version: editor.document.version,
        root,
        relativePath,
        lines,
      });
      this.applyCurrentLine(editor);
    } catch {
      if (requestId === this.requestId) {
        this.cache.delete(editor.document.uri.toString());
        editor.setDecorations(this.decoration, []);
      }
    }
  }

  public async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Hover | undefined> {
    const activeEditor = vscode.window.activeTextEditor;
    if (
      !activeEditor
      || activeEditor.document.uri.toString() !== document.uri.toString()
      || activeEditor.selection.active.line !== position.line
    ) return undefined;

    const cache = this.cache.get(document.uri.toString());
    const line = cache?.version === document.version
      ? cache.lines.find((item) => item.lineNumber === position.line)
      : undefined;
    if (!cache || !line) return undefined;
    return makeBlameHover(this.git, this.hoverCache, cache, document, position, line);
  }

  public async restoreSection(value: unknown): Promise<void> {
    const args = restoreArgs(value);
    if (!args) throw new Error("The blame section to restore is invalid or expired.");

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "file") {
      throw new Error("Open the blamed file before applying its previous code.");
    }

    const root = await this.git.repositoryRoot(editor.document.uri);
    const relativePath = this.git.relativePath(root, editor.document.uri);
    if (root !== args.root || relativePath !== args.relativePath) {
      throw new Error("The blamed file is no longer active. Move back to the original file and try again.");
    }

    const change = await loadParentPatch(this.git, root, relativePath, args.commit);
    const hunk = hunkForLine(change?.patch, args.originalLine + 1);
    const section = hunk
      ? sectionForLine(hunk, args.originalLine + 1, args.sectionEndOriginalLine + 1)
      : undefined;
    if (!change || !section) {
      throw new Error("The previous version of this blamed section is unavailable.");
    }

    const newOffset = args.originalLine + 1 - section.newStart;
    const startLine = args.lineNumber - newOffset;
    const endLine = startLine + section.newLines.length - 1;
    if (
      startLine < 0
      || endLine < startLine
      || endLine >= editor.document.lineCount
    ) {
      throw new Error("The blamed section is no longer present in the current file.");
    }

    const currentLines: string[] = [];
    for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
      currentLines.push(editor.document.lineAt(lineNumber).text);
    }
    if (!sameLines(currentLines, section.newLines)) {
      throw new Error("The blamed section has changed. Refresh the file before applying previous code.");
    }

    const hasFollowingLine = endLine + 1 < editor.document.lineCount;
    const range = hasFollowingLine
      ? new vscode.Range(startLine, 0, endLine + 1, 0)
      : new vscode.Range(startLine, 0, endLine, editor.document.lineAt(endLine).text.length);
    const eol = editor.document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
    const replacement = section.oldLines.join(eol)
      + (hasFollowingLine && section.oldLines.length ? eol : "");
    const edit = new vscode.WorkspaceEdit();
    edit.replace(editor.document.uri, range, replacement);
    if (!(await vscode.workspace.applyEdit(edit))) {
      throw new Error("VS Code could not apply the previous code.");
    }

    this.hoverCache.clear();
    this.scheduleRefresh();
    vscode.window.showInformationMessage("Applied the previous version of this blamed section.");
  }

  private applyCurrentLine(editor: vscode.TextEditor): void {
    if (!this.enabled || editor.document.uri.scheme !== "file") {
      editor.setDecorations(this.decoration, []);
      return;
    }
    const lineNumber = editor.selection.active.line;
    const cache = this.cache.get(editor.document.uri.toString());
    const line = cache?.version === editor.document.version
      ? cache.lines.find((item) => item.lineNumber === lineNumber)
      : undefined;
    if (!line) {
      editor.setDecorations(this.decoration, []);
      return;
    }
    const maxSummary = vscode.workspace.getConfiguration("vvgit.blame").get<number>("inlineSummaryMaxLength", 72);
    const summary = line.summary.length > maxSummary
      ? `${line.summary.slice(0, Math.max(1, maxSummary - 1))}…`
      : line.summary;
    const text = `${blameAuthor(line)} · ${blameDate(line.authorTime)}${summary ? ` · ${summary}` : ""}`;
    editor.setDecorations(this.decoration, [{
      range: lineEndRange(lineNumber),
      renderOptions: { after: { contentText: text } },
    }]);
  }
}

/** Full-file blame annotations rendered in the editor's left annotation column. */
export class FileBlameController implements vscode.Disposable {
  private readonly decoration: vscode.TextEditorDecorationType;
  private readonly compactDecoration: vscode.TextEditorDecorationType;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly cache = new Map<string, BlameCacheEntry>();
  private readonly hoverCache = new Map<string, Promise<CommitHoverInfo>>();
  private refreshTimer: NodeJS.Timeout | undefined;
  private activeUri: string | undefined;
  private lastEditor: vscode.TextEditor | undefined;
  private requestId = 0;

  constructor(private readonly git: GitService) {
    this.decoration = vscode.window.createTextEditorDecorationType({
      rangeBehavior: vscode.DecorationRangeBehavior.OpenOpen,
      before: fileBlameBefore(true),
    });
    this.compactDecoration = vscode.window.createTextEditorDecorationType({
      rangeBehavior: vscode.DecorationRangeBehavior.OpenOpen,
      before: fileBlameBefore(false),
    });
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        const uri = editor?.document.uri.toString();
        // Native decorations stay attached to their editor while the user
        // visits another tab. Re-apply them when a split editor for the same
        // document becomes active, just as GitLens does.
        if (editor && this.activeUri && uri === this.activeUri) {
          this.lastEditor = editor;
          const cache = this.cache.get(this.activeUri);
          if (cache?.version === editor.document.version) this.render(editor, cache);
        }
      }),
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        if (!this.activeUri) return;
        const cache = this.cache.get(this.activeUri);
        if (!cache) return;
        for (const editor of editors) {
          if (editor.document.uri.toString() === this.activeUri && cache.version === editor.document.version) {
            this.lastEditor = editor;
            this.render(editor, cache);
          }
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.uri.toString() === this.activeUri) this.scheduleRefresh();
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        if (document.uri.toString() === this.activeUri) this.clear();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("vvgit.blame")) void this.refresh();
      }),
    );
  }

  public dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    this.clear();
    this.decoration.dispose();
    this.compactDecoration.dispose();
    this.cache.clear();
    this.hoverCache.clear();
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }

  public isShowing(document: vscode.TextDocument): boolean {
    return this.activeUri === document.uri.toString();
  }

  public clear(): void {
    const uri = this.activeUri;
    const editors = new Set<vscode.TextEditor>();
    if (this.lastEditor) editors.add(this.lastEditor);
    for (const editor of vscode.window.visibleTextEditors) {
      if (!uri || editor.document.uri.toString() === uri) editors.add(editor);
    }
    for (const editor of editors) {
      try {
        editor.setDecorations(this.decoration, []);
        editor.setDecorations(this.compactDecoration, []);
      } catch {
        // The editor may have been disposed between the visible-editor event
        // and this cleanup.
      }
    }
    if (uri) this.cache.delete(uri);
    this.activeUri = undefined;
    this.lastEditor = undefined;
    this.requestId += 1;
  }

  public async open(
    editor: vscode.TextEditor,
    root: string,
    relativePath: string,
  ): Promise<void> {
    this.clear();
    this.activeUri = editor.document.uri.toString();
    this.lastEditor = editor;
    try {
      await this.load(editor, root, relativePath);
    } catch (error) {
      this.clear();
      throw error;
    }
  }

  public async refresh(): Promise<void> {
    if (!this.activeUri) return;
    const editor = vscode.window.visibleTextEditors.find(
      (candidate) => candidate.document.uri.toString() === this.activeUri,
    );
    if (!editor) return;
    try {
      const root = await this.git.repositoryRoot(editor.document.uri);
      const relativePath = this.git.relativePath(root, editor.document.uri);
      await this.load(editor, root, relativePath);
    } catch {
      // Keep the last annotations while Git is temporarily unavailable.
    }
  }

  public async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Hover | undefined> {
    const cache = this.cache.get(document.uri.toString());
    const line = cache?.version === document.version
      ? cache.lines.find((item) => item.lineNumber === position.line)
      : undefined;
    if (!cache || !line) return undefined;
    return makeBlameHover(this.git, this.hoverCache, cache, document, position, line);
  }

  private async load(editor: vscode.TextEditor, root: string, relativePath: string): Promise<void> {
    const requestId = ++this.requestId;
    const maxLines = vscode.workspace.getConfiguration("vvgit").get<number>("blame.maxLineCount", 10_000);
    if (editor.document.lineCount > maxLines) {
      this.cache.delete(editor.document.uri.toString());
      editor.setDecorations(this.decoration, []);
      editor.setDecorations(this.compactDecoration, []);
      return;
    }
    const lines = await this.git.blame(root, relativePath);
    if (requestId !== this.requestId || editor.document.uri.toString() !== this.activeUri) return;
    const cache: BlameCacheEntry = {
      version: editor.document.version,
      root,
      relativePath,
      lines,
    };
    this.lastEditor = editor;
    this.cache.set(editor.document.uri.toString(), cache);
    this.render(editor, cache);
  }

  private render(editor: vscode.TextEditor, cache: BlameCacheEntry): void {
    const maxSummary = vscode.workspace.getConfiguration("vvgit.blame").get<number>("fileBlameSummaryMaxLength", 60);
    const leaders: vscode.DecorationOptions[] = [];
    const followers: vscode.DecorationOptions[] = [];
    let previousCommit: string | undefined;

    for (const line of cache.lines) {
      if (line.lineNumber < 0 || line.lineNumber >= editor.document.lineCount) {
        previousCommit = undefined;
        continue;
      }

      const summary = line.summary.length > maxSummary
        ? `${line.summary.slice(0, Math.max(1, maxSummary - 1))}…`
        : line.summary;
      const hash = isUncommitted(line.commit) ? "working" : line.commit.slice(0, 10);
      const text = `${blameAuthor(line)} · ${blameDate(line.authorTime)} · ${summary} · ${hash}`;
      const range = lineStartRange(line.lineNumber);

      // Like GitLens, repeat a commit only at the start of its contiguous
      // block. Followers retain the fixed-width column without visual noise.
      if (previousCommit === line.commit) {
        followers.push({
          range,
          renderOptions: {
            before: {
              // Keep the commit visible on long blocks while the indentation
              // makes it clear that this is a continuation of the same blame.
              contentText: `\u00a0\u00a0${text}`,
              color: isUncommitted(line.commit)
                ? new vscode.ThemeColor("vvgit.fileBlameUncommittedForeground")
                : undefined,
            },
          },
        });
      } else {
        leaders.push({
          range,
          renderOptions: {
            before: {
              contentText: text,
              color: isUncommitted(line.commit)
                ? new vscode.ThemeColor("vvgit.fileBlameUncommittedForeground")
                : undefined,
              textDecoration: "overline solid rgba(0, 0, 0, .2)",
            },
          },
        });
      }
      previousCommit = line.commit;
    }

    editor.setDecorations(this.decoration, leaders);
    editor.setDecorations(this.compactDecoration, followers);
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, 250);
  }
}

export class BlameHoverProvider implements vscode.HoverProvider {
  constructor(
    private readonly inline: InlineBlameController,
    private readonly file: FileBlameController,
  ) {}

  public async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Hover | undefined> {
    return (await this.inline.provideHover(document, position))
      || this.file.provideHover(document, position);
  }
}

export function isBlameCommitUncommitted(commit: string): boolean {
  return isUncommitted(commit);
}
