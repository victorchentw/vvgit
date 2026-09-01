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
}

const TRUSTED_COMMANDS = [
  "vvgit.showCommitMessage",
  "vvgit.showDiff",
  "vvgit.compareCommits",
  "vvgit.searchLog",
  "vvgit.blameFile",
  "vvgit.showBranches",
  "vvgit.mergeBranchToBranch",
  "vvgit.squashBranchToBranch",
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
    commandLink("vvgit.squashBranchToBranch", [], "Squash + patch"),
  ];

  if (!isUncommitted(line.commit)) {
    actions.unshift(
      commandLink("vvgit.showCommitMessage", [line.commit], "Commit message"),
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
    ]).then(([details, stat]) => ({ details, stat }));
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
