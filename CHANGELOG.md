# Changelog

## 0.2.0

- Replaces terminal-style file blame output with a narrow, line-aligned blame editor on the left of the real source editor.
- Keeps the blame pane synchronized with source scrolling and cursor movement.
- Limits inline blame to the active cursor line and shows author, relative time, and commit subject.
- Adds a floating hover card with full commit date, message, changed-line preview, file statistics, hash, and a full-message action.
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
