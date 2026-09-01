# Changelog

## 0.3.0

- Changes full-file blame to an in-editor GitLens-style annotation column before source code, avoiding the awkward duplicate/terminal-like pane.
- Keeps inline blame on the cursor line only.
- Removes diff previews and the `Changes in ...` section from blame hovers to keep them readable.
- Adds hover actions for commit message, diff, compare, history search, file blame, branches, merge, and squash + patch.
- Adds a guarded branch-to-branch merge command and fixes squash commit creation to invoke `git commit` correctly.

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
