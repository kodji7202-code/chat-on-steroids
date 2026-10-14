Second of the three PRs split out of #1296, as requested there. It is independent of #1443 (Code Checkpoints) and is built on current `main` (v2.1.36).

## What it does

A project can now list **quality checks**: up to 8 commands, one per line, run as argv without a shell (double quotes group an argument). They are set from the project menu (**Quality checks**, the menu item shows the count).

When a worker of that project calls `agents action=finish`:

- The checks run in the worker's own marker-verified worktree. The lease is revalidated before every command.
- The run is anchored to the candidate's **content identity**: HEAD, the index, and the bytes of every changed tracked or untracked file. Ignored files are left out, so build output written by a check does not change the identity. If the checks themselves change the candidate, the run fails.
- The first failing command stops the run and the finish is **refused** with its exit status and the last part of its output. Nothing is published.
- If the worker cannot fix it and calls finish again on the unchanged candidate, the finish is accepted and the report the Prime reads starts with `[Quality checks FAILED] …`.
- A pass is recorded as `[Quality checks passed] `npm test`, … on commit <oid> (with uncommitted changes)`.
- A worker without a verified isolated checkout finishes with `[Quality checks not run] …`.
- Each finish call waits up to 20 s. A longer run refuses with progress (`2/3: npm test, 41 s so far`) and the worker calls finish again. Each command has the existing 5-minute exec limit and runs with `CI=1`. One run per worker; results are process-local.

Saving a non-empty list needs a confirmation in the **main process** (`dialog.showMessageBox`, Cancel is the default). The renderer cannot approve commands by itself. Clearing the list or saving it unchanged does not ask.

## Contract

`AGENTS.md` gets the contract first (separate commit), then the implementation:

- owners table row for Quality checks;
- a paragraph after the worker worktree section describing the run, identity, refusal and preface rules.

## Files

- `src/shared/quality-checks.ts`: limits, argv parsing, normalization.
- `src/main/projects.ts`: `qualityChecks` in the catalog schema, `setProjectQualityChecks`, `getSessionQualityChecks`.
- `src/main/worktrees/index.ts`: `workerCandidateIdentity(lease)`, which reuses the cleanup fingerprint with ignored files excluded (separate hash domain).
- `src/main/quality-gate.ts`: the run and the finish decision.
- `src/main/mcp/tools-core.ts`: the `finish` handler asks the gate before `stageFinishAgent`; only a live worker's own finish is gated.
- `src/main/ipc.ts`, `src/preload/index.ts`: `projects:quality-checks` with the main-process confirmation.
- `src/renderer/chat.ts`, `styles.css`: menu item and dialog.
- Locales (12) and main texts.

About 380 non-test, non-locale lines.

## Tests

- `test/quality-gate.test.ts` (new): argv parsing and limits; runs in the worker checkout, not the source repository; failure refusal then FAILED preface; a fixed candidate runs again; a result applies only to the command list it ran with; checks that modify the candidate fail, ignored output does not; refuse while running, one run per worker; no lease.
- `test/mcp-worktree-spawn.test.ts`: in a real worker worktree, the `finish` handler refuses without staging while the check fails, and stages the result with the passed preface once it is fixed.
- `test/ipc.test.ts`: the channel normalizes the list, Cancel saves nothing, Save stores it, clearing does not ask.
- `test/renderer-timeline.test.ts`: menu order, keyboard navigation and the dialog.
- `test/main-texts.test.ts`: guard that every main-text translation fits the 200-character `ui:mainTexts` limit (the same guard is in #1443, where it caught too-long translations; it is duplicated here so either PR can land first).

Fail-first checked: the refusal hook in `finish`, the identity recheck after the run, and the exclusion of ignored files each fail their test when reverted.

## Verification

- `npm run typecheck`: clean.
- `npm run verify`: passes except the 2 `public-history-privacy` tests that also fail on `main` in this environment. `npm run verify:privacy` passes.
- `npm run build`: OK.
- `xvfb-run -a npm run verify:ui`: passes except `verify-workspace-terminal.cjs` (fails on `main` too) and `verify-dropdown-layout.cjs` (flaky: on rerun it passed once and failed once, same as on `main`). `verify-pr-workspace.cjs` now also opens the menu and the dialog and checks the count hint.

## Screenshots

Project menu:

![Project menu with Quality checks](https://raw.githubusercontent.com/kodji7202-code/chat-on-steroids/pr-assets/quality-gates/project-quality-checks-menu.png)

Dialog:

![Quality checks dialog](https://raw.githubusercontent.com/kodji7202-code/chat-on-steroids/pr-assets/quality-gates/project-quality-checks-dialog.png)
