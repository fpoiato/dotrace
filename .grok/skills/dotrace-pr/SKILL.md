---
name: dotrace-pr
description: "Ship every dotrace code change on a new branch with a patch version bump, commit, push, and pull request into main. Use when the user asks for a change, fix, or feature in fpoiato/dotrace."
type: workflow
lifecycle: active
---

# Dotrace PR — branch, bump, commit, push, PR

Use for every user request that changes `fpoiato/dotrace`. Do not edit `main` directly. Questions that do not change files stop after the answer.

Repo: `/workspace/artifacts/dotrace`. Base branch: `main`. Remote: `origin`.

## Workflow

1. From a clean `main`, pull, then create `cursor/<short-slug>`. One request, one branch. Do not reuse a branch that already has an open PR.
2. Do the requested change only on that branch.
3. Bump the patch version in both files, keeping the `-dev` suffix on the dev file:
   - `frontend/dotrace-app/src/environments/environment.prod.ts` (`1.11.27` → `1.11.28`)
   - `frontend/dotrace-app/src/environments/environment.ts` (`1.11.27-dev` → `1.11.28-dev`)
   The pipeline reads the prod file via `pipeline/read-app-version.sh`. Do not bump `agent` or `bot` package versions.
4. Commit with a sentence that says what changed and why. Do not commit secrets (`.env`, tokens, credentials).
5. Push the branch with upstream set.
6. Open a PR into `main` with `gh pr create`. Title is the change. Body has summary and test notes. Return the PR URL.

## Commands

```bash
cd /workspace/artifacts/dotrace
git status --short
git checkout main
git pull --ff-only origin main
git checkout -b cursor/<short-slug>
# edit, then bump version
git add -A
git commit -m "Describe the change."
git push -u origin HEAD
gh pr create --base main --title "Title" --body "$(cat <<'EOF'
## Summary
- What changed and why.

## Test plan
- [ ] What was run or still needs a check.
EOF
)"
```

## Rules

- If `main` is dirty, stash or move the existing work onto the new branch before the bump. Do not drop user changes.
- If push or PR fails on auth, say so and leave the branch and commit in place.
- Do not merge the PR unless the user asks.
- Skip the workflow only when the user explicitly says not to commit, push, or open a PR.
