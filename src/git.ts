import { execFile } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

const MAX_BUFFER = 50 * 1024 * 1024;
const RECORD_SEPARATOR = "\x1e";
const FIELD_SEPARATOR = "\x1f";

export interface GitExecResult {
  stdout: string;
  stderr: string;
  code?: number | string;
}

export class GitCommandError extends Error {
  public readonly command: string;
  public readonly stderr: string;
  public readonly exitCode?: number | string;

  constructor(
    command: string,
    stderr: string,
    exitCode?: number | string,
    cause?: unknown,
  ) {
    const details = stderr.trim();
    const suffix = exitCode === undefined ? "" : ` (exit ${String(exitCode)})`;
    super(details || `${command} failed${suffix}`);
    this.name = "GitCommandError";
    this.command = command;
    this.stderr = details;
    this.exitCode = exitCode;
    if (cause !== undefined) this.cause = cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface CommitSummary {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: string;
  subject: string;
}

export interface CommitDetails extends CommitSummary {
  body: string;
}

export interface BranchInfo {
  name: string;
  hash: string;
  subject: string;
  date: string;
  fullName: string;
  isRemote: boolean;
}

export interface BlameLine {
  lineNumber: number;
  originalLine: number;
  commit: string;
  author: string;
  authorMail: string;
  authorTime?: number;
  summary: string;
}

export interface LogOptions {
  max?: number;
  grep?: string;
  ref?: string;
}

const LOG_FORMAT = [
  "%H",
  "%h",
  "%an",
  "%ae",
  "%aI",
  "%s",
].join(FIELD_SEPARATOR) + RECORD_SEPARATOR;

const COMMIT_FORMAT = [
  "%H",
  "%h",
  "%an",
  "%ae",
  "%aI",
  "%s",
  "%B",
].join(FIELD_SEPARATOR) + RECORD_SEPARATOR;

function asText(value: string | Buffer): string {
  return typeof value === "string" ? value : value.toString("utf8");
}

function parseRecords(output: string): string[][] {
  return output
    .split(RECORD_SEPARATOR)
    .map((record) => record.replace(/^\r?\n/, ""))
    .filter((record) => record.trim().length > 0)
    .map((record) => record.split(FIELD_SEPARATOR));
}

/** Small, argument-safe wrapper around the system git executable. */
export class GitService {
  public get gitPath(): string {
    const configured = vscode.workspace
      .getConfiguration("vvgit")
      .get<string>("gitPath", "git")
      ?.trim();
    return configured || "git";
  }

  private async execute(
    args: string[],
    cwd: string,
    allowExitCodes: Array<number | string> = [],
  ): Promise<GitExecResult> {
    const command = [this.gitPath, ...args].join(" ");
    return new Promise<GitExecResult>((resolve, reject) => {
      execFile(
        this.gitPath,
        args,
        {
          cwd,
          env: {
            ...process.env,
            // Git's machine-readable output should not depend on the user's
            // locale. Commit messages themselves are left untouched.
            LC_ALL: "C",
            LANG: "C",
          },
          encoding: "utf8",
          maxBuffer: MAX_BUFFER,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const textOut = asText(stdout);
          const textErr = asText(stderr);
          const rawCode = error?.code;
          const code: number | string | undefined = rawCode === null ? undefined : rawCode;
          const allowed = code !== undefined && allowExitCodes.some(
            (allowedCode) => String(allowedCode) === String(code),
          );

          if (error && !allowed) {
            reject(new GitCommandError(command, textErr || error.message, code, error));
            return;
          }

          resolve({ stdout: textOut, stderr: textErr, code });
        },
      );
    });
  }

  public async run(args: string[], cwd: string): Promise<string> {
    return (await this.execute(args, cwd)).stdout;
  }

  private startDirectory(uri?: vscode.Uri): string {
    if (uri?.scheme === "file" && uri.fsPath) return path.dirname(uri.fsPath);
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
  }

  public async repositoryRoot(uri?: vscode.Uri): Promise<string> {
    const root = (await this.run(["rev-parse", "--show-toplevel"], this.startDirectory(uri))).trim();
    if (!root) throw new Error("The current folder is not inside a Git repository.");
    return path.normalize(root);
  }

  public relativePath(root: string, uri: vscode.Uri): string {
    if (uri.scheme !== "file") throw new Error("Git actions require a file URI.");
    const rootPath = path.resolve(root);
    const filePath = path.resolve(uri.fsPath);
    const relative = path.relative(rootPath, filePath);
    if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
      throw new Error("The selected file is outside the Git repository.");
    }
    return relative.split(path.sep).join("/");
  }

  private safeRevision(value: string): string {
    const revision = value.trim();
    if (!revision || revision.startsWith("-") || /[\0\r\n\t\s]/.test(revision)) {
      throw new Error(`Invalid Git reference: ${value}`);
    }
    return revision;
  }

  private safeRelativePath(value: string): string {
    const normalized = value.replace(/\\/g, "/");
    if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => part === "..")) {
      throw new Error(`Invalid repository path: ${value}`);
    }
    return normalized;
  }

  public async currentBranch(root: string): Promise<string | undefined> {
    const branch = (await this.run(["branch", "--show-current"], root)).trim();
    if (branch) return branch;
    try {
      return (await this.run(["rev-parse", "--short", "HEAD"], root)).trim() || undefined;
    } catch {
      return undefined;
    }
  }

  public async headHash(root: string): Promise<string> {
    return (await this.run(["rev-parse", "HEAD"], root)).trim();
  }

  public async resolveCommit(root: string, ref: string): Promise<string> {
    const revision = this.safeRevision(ref);
    return (await this.run(["rev-parse", "--verify", `${revision}^{commit}`], root)).trim();
  }

  public async status(root: string): Promise<string> {
    return this.run(["status", "--porcelain=v1", "--untracked-files=all"], root);
  }

  public async operationInProgress(root: string): Promise<string | undefined> {
    const operations: Array<[string, string]> = [
      ["MERGE_HEAD", "merge"],
      ["CHERRY_PICK_HEAD", "cherry-pick"],
      ["REVERT_HEAD", "revert"],
      ["REBASE_HEAD", "rebase"],
    ];
    for (const [ref, name] of operations) {
      const result = await this.execute(["rev-parse", "--verify", "-q", ref], root, [1, 128]);
      if (result.code === undefined) return name;
    }
    return undefined;
  }

  public async branches(root: string): Promise<BranchInfo[]> {
    const format = [
      "%(refname:short)",
      "%(objectname)",
      "%(subject)",
      "%(committerdate:iso-strict)",
      "%(refname)",
    ].join(FIELD_SEPARATOR) + RECORD_SEPARATOR;
    const output = await this.run([
      "for-each-ref",
      "--sort=-committerdate",
      `--format=${format}`,
      "refs/heads",
      "refs/remotes",
    ], root);

    return parseRecords(output)
      .map((fields) => {
        const [name = "", hash = "", subject = "", date = "", fullName = ""] = fields;
        return {
          name,
          hash,
          subject,
          date,
          fullName,
          isRemote: fullName.startsWith("refs/remotes/"),
        };
      })
      .filter((branch) => branch.name && !branch.name.endsWith("/HEAD"));
  }

  public async log(root: string, options: LogOptions = {}): Promise<CommitSummary[]> {
    const max = Math.max(1, Math.min(2_000, Math.round(options.max || 200)));
    const args = [
      "log",
      "--no-color",
      "--no-decorate",
      "--date=iso-strict",
      `--format=${LOG_FORMAT}`,
      "-n",
      String(max),
    ];
    if (options.grep?.trim()) {
      args.push(`--grep=${options.grep.trim()}`, "--regexp-ignore-case");
    }
    args.push(options.ref ? this.safeRevision(options.ref) : "--all");

    const output = await this.run(args, root);
    return parseRecords(output)
      .map((fields) => ({
        hash: fields[0] || "",
        shortHash: fields[1] || "",
        author: fields[2] || "",
        email: fields[3] || "",
        date: fields[4] || "",
        subject: fields[5] || "(no subject)",
      }))
      .filter((commit) => !!commit.hash);
  }

  public async commit(root: string, ref: string): Promise<CommitDetails> {
    const revision = this.safeRevision(ref);
    const output = await this.run([
      "show",
      "--no-patch",
      "--no-color",
      "--no-ext-diff",
      "--date=iso-strict",
      `--format=${COMMIT_FORMAT}`,
      revision,
    ], root);
    const fields = parseRecords(output)[0] || [];
    return {
      hash: fields[0] || "",
      shortHash: fields[1] || "",
      author: fields[2] || "",
      email: fields[3] || "",
      date: fields[4] || "",
      subject: fields[5] || "(no subject)",
      body: fields.slice(6).join(FIELD_SEPARATOR).trim(),
    };
  }

  public async commitStat(root: string, ref: string): Promise<string> {
    return this.run([
      "show",
      "--no-color",
      "--no-ext-diff",
      "--stat",
      "--format=",
      this.safeRevision(ref),
    ], root);
  }

  public async blame(root: string, relativePath: string): Promise<BlameLine[]> {
    const file = this.safeRelativePath(relativePath);
    const output = await this.run([
      "blame",
      "--line-porcelain",
      "--no-progress",
      "--",
      file,
    ], root);
    const lines = output.split(/\r?\n/);
    const records: BlameLine[] = [];

    for (let index = 0; index < lines.length; index++) {
      const header = lines[index].match(/^([\^]?[0-9a-f]{4,40})\s+(\d+)\s+(\d+)(?:\s+(\d+))?\s*$/i);
      if (!header) continue;

      const record: Partial<BlameLine> = {
        lineNumber: records.length,
        originalLine: Math.max(0, Number(header[2]) - 1),
        commit: header[1].replace(/^\^/, ""),
        author: "Unknown",
        authorMail: "",
        summary: "(no commit message)",
      };
      let sourceLineFound = false;
      for (index += 1; index < lines.length; index++) {
        const line = lines[index];
        if (line.startsWith("\t")) {
          sourceLineFound = true;
          break;
        }
        const separator = line.indexOf(" ");
        if (separator <= 0) continue;
        const key = line.slice(0, separator);
        const value = line.slice(separator + 1);
        switch (key) {
          case "author":
            record.author = value || "Unknown";
            break;
          case "author-mail":
            record.authorMail = value.replace(/^<|>$/g, "");
            break;
          case "author-time": {
            const timestamp = Number(value);
            if (Number.isFinite(timestamp)) record.authorTime = timestamp;
            break;
          }
          case "summary":
            record.summary = value || "(no commit message)";
            break;
        }
      }

      if (sourceLineFound && record.commit) records.push(record as BlameLine);
    }
    return records;
  }

  public async formatPatch(root: string, ref: string): Promise<string> {
    return this.run([
      "format-patch",
      "-1",
      this.safeRevision(ref),
      "--stdout",
    ], root);
  }

  public async isTracked(root: string, relativePath: string): Promise<boolean> {
    const file = this.safeRelativePath(relativePath);
    const result = await this.execute([
      "ls-files",
      "--error-unmatch",
      "--",
      file,
    ], root, [1, 128]);
    return result.code === undefined;
  }

  public async untrackedFiles(root: string): Promise<string[]> {
    const output = await this.run([
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ], root);
    return output
      .split("\0")
      .filter((file) => file.length > 0);
  }

  public async diff(
    root: string,
    left?: string,
    right?: string,
    relativePath?: string,
  ): Promise<string> {
    const args = ["diff", "--no-color", "--no-ext-diff", "--find-renames"];
    if (left) args.push(this.safeRevision(left));
    if (right) args.push(this.safeRevision(right));
    args.push("--");
    if (relativePath) args.push(this.safeRelativePath(relativePath));
    return this.run(args, root);
  }

  public async diffNoIndex(root: string, relativePath: string): Promise<string> {
    const file = this.safeRelativePath(relativePath);
    const absolute = path.resolve(root, file);
    const result = await this.execute([
      "diff",
      "--no-index",
      "--no-color",
      "--no-ext-diff",
      "--",
      os.devNull,
      absolute,
    ], root, [1]);
    return result.stdout;
  }

  public async showFile(root: string, ref: string, relativePath: string): Promise<string> {
    const revision = this.safeRevision(ref);
    const file = this.safeRelativePath(relativePath);
    const result = await this.execute([
      "show",
      "--no-color",
      "--no-ext-diff",
      `${revision}:${file}`,
    ], root, [1, 128]);
    if (result.code !== undefined) return "";
    return result.stdout;
  }

  public async checkout(root: string, branch: string): Promise<void> {
    await this.run(["checkout", "--quiet", this.safeRevision(branch)], root);
  }

  public async createCommit(root: string, message: string): Promise<void> {
    const subject = message.trim();
    if (!subject) throw new Error("A commit message is required.");
    await this.run(["commit", "-m", subject], root);
  }

  public async merge(root: string, sourceBranch: string): Promise<void> {
    await this.run([
      "merge",
      "--no-ff",
      "--no-edit",
      this.safeRevision(sourceBranch),
    ], root);
  }

  public async mergeSquash(root: string, sourceBranch: string): Promise<void> {
    await this.run([
      "merge",
      "--squash",
      "--no-edit",
      this.safeRevision(sourceBranch),
    ], root);
  }

  public async commitsAhead(root: string, targetBranch: string, sourceBranch: string): Promise<number> {
    const target = this.safeRevision(targetBranch);
    const source = this.safeRevision(sourceBranch);
    const output = await this.run(["rev-list", "--count", `${target}..${source}`], root);
    const count = Number.parseInt(output.trim(), 10);
    return Number.isFinite(count) ? count : 0;
  }

  public async resetHard(root: string, ref: string): Promise<void> {
    await this.run(["reset", "--hard", this.safeRevision(ref)], root);
  }
}
