# Changelog

## 0.3.8

- Applies the `<filename>_diff` virtual filename to single-file commit patch views as well as all-file views.

## 0.3.7

- Adds `Show patch for all files`, opening one VS Code diff document per changed file with `<filename>_diff` tab names.

## 0.3.6

- Fixes commit file parsing so search and branch-log actions can list changed files and open a selected file's patch.

## 0.3.5

- Names branch-to-branch squash artifacts as `<source>_TO_<target>.patch` and uses that filename as the squash commit message.
- Leaves merge conflicts in the checked-out target branch and tells the user to resolve and complete or reset the merge manually.

## 0.3.4

- Adds `Squash to branch` to search-result and floating blame commit actions; it squashes history through the selected commit into a local target branch.
- Uses `<source-branch>.squash.patch` as the default branch-to-branch squash patch filename.

## 0.3.3

- Makes commit-message search update dynamically while typing, including backspace edits after a search has started.
- Keeps search actions available from floating blame hovers and adds commit patch inspection after selection.

## 0.3.2

- Adds an active commit-message preview to search and branch-log quick picks.
- Adds follow-up actions for commit message, full patch, per-file patch, changed-file list, and copying the commit hash.

## 0.3.1

- Changes the Git graph accent in the extension icon from purple to Git orange-red.

## 0.3.0

- Changes full-file blame to an in-editor GitLens-style annotation column before source code, avoiding the awkward duplicate/terminal-like pane.
- Keeps inline blame on the cursor line only.
- Removes diff previews and the `Changes in ...` section from blame hovers to keep them readable.
- Adds hover actions for commit message, diff, compare, history search, file blame, branches, merge, and squash + patch.
- Adds a guarded branch-to-branch merge command and fixes squash commit creation to invoke `git commit` correctly.
- Keeps commit metadata visible on continued blame blocks with indentation, brackets hover actions clearly, and permits remote-tracking source refs when the target is local.

## 0.2.0

- Replaces terminal-style file blame output with GitLens-style line-aligned annotations before the source code in the same editor.
- Keeps full-file blame native to the editor's scrolling and line layout.
- Limits inline blame to the active cursor line and shows author, relative time, and commit subject.
- Adds a clean floating hover card with full commit date, message, file statistics, hash, and quick Git actions.
- Adds compact editor-title Git actions for search, compare, branch browsing, repository diff, and squash-to-patch.

## 0.1.0 — Initial release

- Adds fast inline blame decorations with author and commit time after each line.
- Adds full-file blame output with commit summaries.
- Adds quick commit-message display from blame hovers, refs, and history search.
- Adds current-file, repository, and untracked-file diff views.
- Adds commit/reference and branch comparison in a read-only diff editor.
- Adds commit-message search and branch log browsing.
- Adds squash-merge workflow from one local branch to another with automatic `format-patch -1` output.
- Adds the VV Git extension icon, editor actions, keyboard shortcuts, and a lightweight native VS Code UI.
