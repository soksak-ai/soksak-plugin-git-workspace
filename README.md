# soksak-plugin-git-workspace

Worktree workspaces for soksak. One command opens a branch and a git worktree, gives it
its own window with a terminal rooted at the worktree, and lists the workspaces you have
open. Closing a workspace reclaims the worktree and its window; the branch and its commits
survive.

## Commands

- `worktree.open` — Open a worktree workspace. Given a branch name or issue slug, create the
  branch and worktree (through whatever implements `soksak-git-spec@1`), then open a project window whose default
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

`worktree.open`/`close`/`list` run no git. The git operations they need — repository root
discovery, branch existence, worktree add/list/remove — come from **`soksak-git-spec@1`**, and the
plugin that implements it is found **by contract, never by name**: the manifest declares
`consumes: ["soksak-git-spec@1"]`, the implementer is resolved through `plugin.implementers`, and no
plugin id appears in this plugin's code or manifest. Swap the implementer and nothing here changes.
No enabled implementer is a loud refusal (`NO_GIT_PROVIDER`), never an empty workspace list.

Because it runs no git, it holds **no `process` permission** — it cannot spawn anything at all.
That is the point: a plugin that ran git had to carry its own ref whitelist and path proof, and a
duplicated defense is a security debt. Those rules now live in the contract, and are scored there.

Window, terminal, and panel orchestration go through core registry commands. The plugin persists
its workspace records in the core data store (`data` permission).
