# soksak-plugin-git-workspace

Worktree workspaces for soksak. One command opens a branch and a git worktree, gives it
its own window with a terminal rooted at the worktree, and lists the workspaces you have
open. Closing a workspace reclaims the worktree and its window; the branch and its commits
survive.

## Commands

- `worktree.open` — Open a worktree workspace. Given a branch name or issue slug, create the
  branch and worktree (via `soksak-plugin-git-core`), then open a project window whose default
  terminal is rooted at the worktree. Idempotent: opening an existing workspace focuses its
  window instead of minting a second one.
- `worktree.close` — Close a worktree workspace: close its window and remove the worktree
  checkout. The branch and its commits are not touched. No-op when the workspace is absent.
- `worktree.list` — List active worktree workspaces (the same records the view shows).

## View

A **Workspaces** panel (sidebar or content) lists the open worktree workspaces. Each row focuses
its window on click; a per-row control reclaims it. The panel reports its state (loading / empty /
active / error) on the view status axis.

## Contract

`worktree.open`/`close`/`list` own no git execution of their own — the git operations (worktree
add/list/remove, repository root discovery) are delegated to `soksak-plugin-git-core`, declared as
a dependency. Window, terminal, and panel orchestration go through core registry commands. The
plugin persists its workspace records in the core data store (`data` permission).
