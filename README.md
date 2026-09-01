# VV Git — Fast Git History for VS Code

A small, focused VS Code extension for Git blame, commit history, diffs, branch comparison, and squash-to-patch workflows. **VV Git** uses the local `git` executable and native VS Code quick picks/editors instead of a large webview or a full repository graph.

Current release: `0.2.0`

Repository: `git@github.com:victorchentw/vvgit.git`

---

## Installation

Install from the VS Code Marketplace when published, or install a packaged `.vsix` file:

```bash
code --install-extension vvgit-0.2.0.vsix
```

Open a Git workspace. Inline blame is enabled by default and appears only on the active cursor line.

---

## Features

- **Inline cursor blame** — Shows only the active line's author, relative time, and commit subject. Hover the line for a floating GitLens-style card with the full date, commit message, changed lines, file statistics, hash, and a one-click full-message action.
- **Side-by-side file blame** — **VV Git: Blame Current File** opens a narrow, line-aligned blame pane on the left and the real source editor on the right. The left pane follows source scrolling and cursor movement and shows author, relative time, subject, and short hash for every line.
- **Native Git views** — Blame and diff views use normal VS Code editors and quick picks rather than a terminal transcript or a large webview.
- **Commit messages** — Search recent commits or choose a reference and display the full message, author, date, and changed-file summary quickly.
- **File and repository diff** — Compare the current file with `HEAD`, or open the complete working-tree diff, including untracked files.
- **Commit comparison** — Quickly compare two commits, branches, tags, or other Git references in a read-only diff editor.
- **Commit-message search** — Search all reachable history by ticket number, keyword, or phrase.
- **Branch browsing** — Pick a local/remote branch and browse its recent log.
- **Squash branch to branch + patch** — Select source `BIA-222` and target `dev`; VV Git checks out `dev`, performs a squash merge, creates the commit, and writes `git format-patch -1 BIA-222 --stdout` to a patch file.
- **Lightweight by design** — No GitHub account, background service, repository database, graph renderer, or bundled Git implementation. Commands run only when needed.

### Squash example

1. Run **VV Git: Squash Branch to Branch + Create Patch**.
2. Select `BIA-222` as the source and `dev` as the target.
3. Enter the squash commit message and patch path (default: `patches/BIA-222.format-patch-1.patch`).
4. Confirm the operation.

The working tree must be clean. If the squash encounters a conflict or the commit fails, VV Git resets the attempted merge and restores the original branch. After a successful operation, the target branch remains checked out and the patch contains the latest source-branch commit exactly as produced by `format-patch -1`.

---

## Commands

Open the Command Palette (`Ctrl/Cmd+Shift+P`) and search for **VV Git**:

| Command | Purpose |
| :--- | :--- |
| `Toggle Inline Blame` | Turn the active-line author/time/subject decoration on or off. |
| `Blame Current File` | Open a line-aligned blame pane on the left of the source editor. |
| `Show Commit Message` | Pick a commit/reference and show its message and stat. |
| `Show File Diff` | Compare the active file with `HEAD`. |
| `Show Repository Diff` | Show tracked and untracked working-tree changes. |
| `Search Commit Messages` | Find commits by message text. |
| `Browse Branch Log` | Browse commits on a selected branch. |
| `Compare Commits or References` | Compare two commits, branches, tags, or refs. |
| `Compare Branches` | Compare two branches directly. |
| `Squash Branch to Branch + Create Patch` | Squash a source branch into a target and create `format-patch -1`. |
| `Browse Branches` | Pick a branch and open its recent log. |

The file actions are available from the editor title bar, editor context menu, and Explorer context menu. History search, commit/reference comparison, branch browsing, repository diff, and squash-to-patch are also available as compact Git buttons in the editor title bar.

---

## Requirements

- VS Code `1.85` or newer
- Git available on `PATH`

If Git is installed outside `PATH`, set `vvgit.gitPath` to its command name or absolute path.

---

## Extension Settings

| Setting | Type | Default | Description |
| :--- | :---: | :---: | :--- |
| `vvgit.gitPath` | String | `"git"` | Git executable name or absolute path. |
| `vvgit.inlineBlame` | Boolean | `true` | Show author, relative time, and subject only after the active cursor line. |
| `vvgit.blame.dateFormat` | String | `"relative"` | `relative`, `short`, or `iso`. |
| `vvgit.blame.maxLineCount` | Number | `10000` | Skip inline blame for files larger than this limit. |
| `vvgit.blame.inlineSummaryMaxLength` | Number | `72` | Maximum subject length shown beside the cursor line. |
| `vvgit.blame.sidecarSummaryMaxLength` | Number | `80` | Maximum subject length shown in the left blame pane. |
| `vvgit.log.maxCommits` | Number | `250` | Maximum commits loaded into history quick picks. |
| `vvgit.patchDirectory` | String | `"patches"` | Default squash patch directory, relative to the repository root. |

---

## Development

```bash
npm install
npm run check
npm run build
```

To package a release:

```bash
npx @vscode/vsce package
```

The extension has no runtime dependencies beyond VS Code and the local Git executable.

---

## License

MIT License
