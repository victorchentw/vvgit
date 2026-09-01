import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { GitService } from "./git";

interface SnapshotPayload {
  root: string;
  ref: string;
  relativePath: string;
}

/** Read-only documents used to display Git snapshots and repository diffs. */
export class GitDocumentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly diffDocuments = new Map<string, string>();
  private sequence = 0;

  constructor(private readonly git: GitService) {}

  public dispose(): void {
    this.diffDocuments.clear();
  }

  public provideTextDocumentContent(
    uri: vscode.Uri,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<string> {
    if (uri.scheme === "vvgit-diff") {
      return this.diffDocuments.get(uri.path.split("/").pop() || "") || "";
    }

    const payload = this.payload(uri);
    if (!payload) return "";
    if (uri.scheme === "vvgit-ref") {
      return this.git.showFile(payload.root, payload.ref, payload.relativePath).catch(() => "");
    }
    if (uri.scheme === "vvgit-worktree") return this.worktreeText(payload);
    return "";
  }

  public refUri(root: string, ref: string, relativePath: string): vscode.Uri {
    return this.payloadUri("vvgit-ref", { root, ref, relativePath });
  }

  public worktreeUri(root: string, relativePath: string): vscode.Uri {
    return this.payloadUri("vvgit-worktree", { root, ref: "", relativePath });
  }

  public diffUri(content: string): vscode.Uri {
    const id = `${Date.now().toString(36)}-${(++this.sequence).toString(36)}`;
    this.diffDocuments.set(id, content);
    // Keep the provider bounded when a user repeatedly compares large refs.
    while (this.diffDocuments.size > 5) {
      const first = this.diffDocuments.keys().next().value;
      if (!first) break;
      this.diffDocuments.delete(first);
    }
    return vscode.Uri.parse(`vvgit-diff:/diff/${id}`);
  }

  private payloadUri(scheme: string, payload: SnapshotPayload): vscode.Uri {
    return vscode.Uri.parse(`${scheme}:/snapshot?${encodeURIComponent(JSON.stringify(payload))}`);
  }

  private payload(uri: vscode.Uri): SnapshotPayload | undefined {
    const candidates = [uri.query];
    try {
      candidates.push(decodeURIComponent(uri.query));
    } catch {
      // The raw query may already be decoded by VS Code.
    }
    for (const candidate of candidates) {
      if (!candidate) continue;
      try {
        const value = JSON.parse(candidate) as Partial<SnapshotPayload>;
        if (
          typeof value.root === "string" &&
          typeof value.ref === "string" &&
          typeof value.relativePath === "string"
        ) {
          return value as SnapshotPayload;
        }
      } catch {
        // Try the next representation.
      }
    }
    return undefined;
  }

  private async worktreeText(payload: SnapshotPayload): Promise<string> {
    const absolutePath = path.resolve(payload.root, payload.relativePath);
    const document = vscode.workspace.textDocuments.find(
      (candidate) => candidate.uri.scheme === "file" && path.resolve(candidate.uri.fsPath) === absolutePath,
    );
    if (document) return document.getText();

    try {
      return await fs.readFile(absolutePath, "utf8");
    } catch {
      return "";
    }
  }
}
