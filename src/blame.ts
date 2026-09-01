import * as vscode from "vscode";
import { BlameLine, CommitDetails, GitService } from "./git";
import { GitDocumentProvider } from "./virtual-documents";

interface BlameCacheEntry {
  version: number;
  root: string;
  relativePath: string;
  lines: BlameLine[];
}

interface CommitHoverInfo {
  details?: CommitDetails;
  stat?: string;
  diff?: string;
}

interface BlameSidecarSession {
  sourceUri: vscode.Uri;
  root: string;
  relativePath: string;
  blameUri: vscode.Uri;
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

function commitLink(commit: string): string {
  const command = `command:vvgit.showCommitMessage?${encodeURIComponent(JSON.stringify([commit]))}`;
  return `[Show full commit message](${command})`;
}

function statSummary(stat: string | undefined): string | undefined {
  if (!stat) return undefined;
  return stat
    .split(/\r?\n/)
    .map((line) => line.trim())
    .reverse()
    .find((line) => /\d+ files? changed/.test(line));
}

function diffSnippet(diff: string | undefined, sourceLine: string): string {
  const changed = (diff || "")
    .split(/\r?\n/)
    .filter((line) => /^[+-]/.test(line) && !line.startsWith("+++") && !line.startsWith("---"))
    .slice(0, 12);
  if (changed.length) return changed.join("\n").slice(0, 4_000);
  return `+ ${sourceLine}`.slice(0, 4_000);
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
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      after: {
        color: new vscode.ThemeColor("editorCodeLens.foreground"),
        fontStyle: "normal",
        fontWeight: "normal",
        margin: "0 0 0 2em",
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

  public isEnabled(): boolean {
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

  public line(document: vscode.TextDocument, lineNumber: number): BlameLine | undefined {
    const cached = this.cache.get(document.uri.toString());
    if (!cached || cached.version !== document.version) return undefined;
    return cached.lines.find((line) => line.lineNumber === lineNumber);
  }

  private applyCurrentLine(editor: vscode.TextEditor): void {
    if (!this.enabled || editor.document.uri.scheme !== "file") {
      editor.setDecorations(this.decoration, []);
      return;
    }
    const lineNumber = editor.selection.active.line;
    const line = this.line(editor.document, lineNumber);
    if (!line) {
      editor.setDecorations(this.decoration, []);
      return;
    }
    const maxSummary = vscode.workspace.getConfiguration("vvgit.blame").get<number>("inlineSummaryMaxLength", 72);
    const summary = line.summary.length > maxSummary
      ? `${line.summary.slice(0, Math.max(1, maxSummary - 1))}…`
      : line.summary;
    const text = `${blameAuthor(line)} · ${blameDate(line.authorTime)}${summary ? ` · ${summary}` : ""}`;
    const end = editor.document.lineAt(lineNumber).text.length;
    editor.setDecorations(this.decoration, [{
      range: new vscode.Range(lineNumber, 0, lineNumber, end),
      renderOptions: { after: { contentText: text } },
    }]);
  }

  private async hoverInfo(cache: BlameCacheEntry, line: BlameLine): Promise<CommitHoverInfo> {
    if (isUncommitted(line.commit)) return {};
    const key = `${cache.root}\u0000${cache.relativePath}\u0000${line.commit}`;
    const existing = this.hoverCache.get(key);
    if (existing) return existing;

    const promise = Promise.all([
      this.git.commit(cache.root, line.commit).catch(() => undefined),
      this.git.commitStat(cache.root, line.commit).catch(() => undefined),
      this.git.commitDiff(cache.root, line.commit, cache.relativePath).catch(() => undefined),
    ]).then(([details, stat, diff]) => ({ details, stat, diff }));
    this.hoverCache.set(key, promise);
    return promise;
  }

  public async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Hover | undefined> {
    const line = this.line(document, position.line);
    if (!line) return undefined;
    const cache = this.cache.get(document.uri.toString());
    if (!cache || cache.version !== document.version) return undefined;

    const markdown = new vscode.MarkdownString();
    markdown.appendMarkdown(`**${markdownText(blameAuthor(line))}** · ${markdownText(blameDate(line.authorTime))} (${markdownText(blameFullDate(line.authorTime))})\n\n`);
    const sourceLine = document.lineAt(position.line).text;

    if (isUncommitted(line.commit)) {
      markdown.appendMarkdown("**Working tree change**\n\n");
      markdown.appendCodeblock(`+ ${sourceLine}`, "diff");
      return new vscode.Hover(markdown, new vscode.Range(position.line, 0, position.line, sourceLine.length));
    }

    const info = await this.hoverInfo(cache, line);
    const details = info.details;
    const subject = details?.subject || line.summary || "(no commit message)";
    markdown.appendMarkdown(`**${markdownText(subject)}**\n\n`);
    const body = details?.body || "";
    const rest = body.split(/\r?\n/).slice(1).join("\n").trim();
    if (rest) markdown.appendText(`${rest}\n\n`);

    const shortHash = line.commit.slice(0, 10);
    markdown.appendMarkdown(`\`${shortHash}\` · ${markdownText(cache.relativePath)}\n\n`);
    markdown.appendMarkdown(`**Changes in ${shortHash}**\n\n`);
    markdown.appendCodeblock(diffSnippet(info.diff, sourceLine), "diff");
    const summary = statSummary(info.stat);
    if (summary) markdown.appendMarkdown(`\n**${markdownText(summary)}**\n\n`);
    markdown.appendMarkdown(commitLink(line.commit));
    markdown.isTrusted = { enabledCommands: ["vvgit.showCommitMessage"] };

    return new vscode.Hover(markdown, new vscode.Range(position.line, 0, position.line, sourceLine.length));
  }
}

export class BlameHoverProvider implements vscode.HoverProvider {
  constructor(private readonly controller: InlineBlameController) {}

  public provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.ProviderResult<vscode.Hover> {
    return this.controller.provideHover(document, position);
  }
}

/** Opens a narrow, line-aligned blame editor on the left of the real source editor. */
export class BlameSidecarController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private session: BlameSidecarSession | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  private syncing = false;

  constructor(
    private readonly git: GitService,
    private readonly documents: GitDocumentProvider,
  ) {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (this.session?.sourceUri.toString() !== event.document.uri.toString()) return;
        this.scheduleRefresh();
      }),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        const session = this.session;
        if (!session) return;
        if (event.textEditor.document.uri.toString() === session.sourceUri.toString()) {
          this.reveal(this.sidecarEditor(), event.selections[0]?.active.line ?? 0);
        } else if (event.textEditor.document.uri.toString() === session.blameUri.toString()) {
          this.reveal(this.sourceEditor(), event.selections[0]?.active.line ?? 0);
        }
      }),
      vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
        const session = this.session;
        if (!session || !event.visibleRanges.length) return;
        const uri = event.textEditor.document.uri.toString();
        if (uri === session.sourceUri.toString()) {
          this.reveal(this.sidecarEditor(), event.visibleRanges[0].start.line);
        } else if (uri === session.blameUri.toString()) {
          this.reveal(this.sourceEditor(), event.visibleRanges[0].start.line);
        }
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        if (document.uri.toString() === this.session?.sourceUri.toString()
          || document.uri.toString() === this.session?.blameUri.toString()) {
          this.session = undefined;
        }
      }),
    );
  }

  public dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    this.session = undefined;
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }

  public async open(
    sourceDocument: vscode.TextDocument,
    root: string,
    relativePath: string,
  ): Promise<void> {
    if (this.session?.sourceUri.toString() === sourceDocument.uri.toString()) {
      await this.refresh();
      const source = await this.showSource(sourceDocument);
      this.reveal(this.sidecarEditor(), source.selection.active.line);
      return;
    }

    const lines = await this.git.blame(root, relativePath);
    const blameUri = this.documents.blameUri(relativePath);
    this.documents.setBlameContent(blameUri, this.sidecarContent(lines, sourceDocument.lineCount));

    const source = await vscode.window.showTextDocument(sourceDocument, {
      viewColumn: vscode.ViewColumn.Two,
      preview: false,
      preserveFocus: false,
    });
    const blameDocument = await vscode.workspace.openTextDocument(blameUri);
    const sidecar = await vscode.window.showTextDocument(blameDocument, {
      viewColumn: vscode.ViewColumn.One,
      preview: false,
      preserveFocus: true,
    });
    sidecar.options = {
      ...sidecar.options,
      lineNumbers: vscode.TextEditorLineNumbersStyle.Off,
    };
    this.session = { sourceUri: sourceDocument.uri, root, relativePath, blameUri };
    this.reveal(sidecar, source.selection.active.line);
    await vscode.window.showTextDocument(sourceDocument, {
      viewColumn: vscode.ViewColumn.Two,
      preview: false,
      preserveFocus: false,
    });
  }

  public async refresh(): Promise<void> {
    const session = this.session;
    if (!session) return;
    const sourceDocument = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === session.sourceUri.toString(),
    );
    if (!sourceDocument) return;
    try {
      const lines = await this.git.blame(session.root, session.relativePath);
      this.documents.setBlameContent(
        session.blameUri,
        this.sidecarContent(lines, sourceDocument.lineCount),
      );
    } catch {
      // Keep the last useful blame view when Git is temporarily unavailable.
    }
  }

  public async refreshActive(): Promise<void> {
    await this.refresh();
  }

  public activeRoot(): string | undefined {
    const activeUri = vscode.window.activeTextEditor?.document.uri.toString();
    return activeUri && activeUri === this.session?.blameUri.toString() ? this.session.root : undefined;
  }

  private async showSource(document: vscode.TextDocument): Promise<vscode.TextEditor> {
    return vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.Two,
      preview: false,
      preserveFocus: false,
    });
  }

  private sourceEditor(): vscode.TextEditor | undefined {
    const session = this.session;
    if (!session) return undefined;
    return vscode.window.visibleTextEditors.find(
      (editor) => editor.document.uri.toString() === session.sourceUri.toString()
        && editor.viewColumn === vscode.ViewColumn.Two,
    ) || vscode.window.visibleTextEditors.find(
      (editor) => editor.document.uri.toString() === session.sourceUri.toString(),
    );
  }

  private sidecarEditor(): vscode.TextEditor | undefined {
    const session = this.session;
    if (!session) return undefined;
    return vscode.window.visibleTextEditors.find(
      (editor) => editor.document.uri.toString() === session.blameUri.toString(),
    );
  }

  private reveal(editor: vscode.TextEditor | undefined, line: number): void {
    if (!editor || this.syncing || editor.document.lineCount === 0) return;
    const targetLine = Math.min(Math.max(0, line), editor.document.lineCount - 1);
    this.syncing = true;
    editor.revealRange(
      new vscode.Range(targetLine, 0, targetLine, 0),
      vscode.TextEditorRevealType.InCenterIfOutsideViewport,
    );
    setTimeout(() => { this.syncing = false; }, 0);
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, 250);
  }

  private sidecarContent(lines: BlameLine[], sourceLineCount: number): string {
    const maxSummary = vscode.workspace.getConfiguration("vvgit.blame").get<number>("sidecarSummaryMaxLength", 80);
    const output: string[] = [];
    for (let index = 0; index < sourceLineCount; index++) {
      const line = lines[index];
      if (!line) {
        output.push("—");
        continue;
      }
      const summary = line.summary.length > maxSummary
        ? `${line.summary.slice(0, Math.max(1, maxSummary - 1))}…`
        : line.summary;
      const hash = isUncommitted(line.commit) ? "working" : line.commit.slice(0, 10);
      output.push(`${blameAuthor(line)} · ${blameDate(line.authorTime)} · ${summary} · ${hash}`);
    }
    return output.join("\n");
  }
}

export function isBlameCommitUncommitted(commit: string): boolean {
  return isUncommitted(commit);
}
