# Isolated worker workspaces, quality gates, checkpoints and scheduled jobs

This document describes the opt-in mission execution primitives introduced after CoS 2.1.34.
The ordinary ChatGPT-backed agent broker, browser extension, session recorder and outbox retain
their existing ownership and authorization rules. No new model provider or quota is implied.

## 1. Worker worktrees

Turn on **Settings → Multi-agent → Isolate new workers in Git worktrees** to allocate a distinct
Git checkout and branch to each newly invited `worker-N`. The setting is **Off by default**.
CoS requires a Git repository below an approved **parent** folder: the parent must also be
approved because worker checkouts are stored outside the original repository, under
`<approved parent>/.chat-on-steroids-worktrees/<repo>/<runId>/<worker-N>/tree`.

`agents action=spawn` invokes the worktree manager after the broker reserves the exact
prime/run/worker identities and before worker chat openings are handed to the browser.
Allocation failure rolls the staged broker admission back; it does not reset or clean existing
files. Existing workers and workspaces are unchanged if the switch is toggled later. Managed
worktrees have independently verified owner markers. On restart, the app checks the markers,
Git metadata and approved roots before restoring the corresponding worker workspace.

The worker branch may contain uncommitted changes. The manager's integration API requires a
clean target, a committed/clean worker state, an exact target HEAD and a live valid quality
gate. Divergence is reconciled inside the worker worktree, not the user's checkout; a merge
changes the candidate revision and therefore requires fresh validation. The integration code
permits only a fast-forward after the final verification. Cleanup retains dirty worktrees
unless explicitly authorized to discard their exact, marker-proven contents.

This is **checkout isolation**, not an operating-system sandbox: `exec_command` still runs
as the signed-in OS user, so a worker with command access can explicitly reference other
permitted paths. The approved-root and live capability policies remain necessary.

## 2. Candidate quality gates

`src/main/quality/` captures an exact Git base/commit/tree and hashed owned-path diff tied
to `{runId,agentId}`. A `GatePolicy` names the test commands and minimum independent reviewer
approvals. `runNamedTest(s)` verifies the candidate before and after each test. Independent
validator receipts cannot approve their own candidate owner. `evaluateGate` fails closed if
any test, reviewer receipt or candidate evidence is missing, ambiguous, failed or stale.

The authorized integration API in `src/main/worktrees/` calls
`verifyGateForCandidate()` again at the mutation boundary. A caller-supplied
`{approved:true}`, or a gate loaded back from a JSON file, **is not** an integration token.
Persisted receipts are audit history. `issueValidatorReceipt` is a **trusted internal API**;
future UI/MCP endpoints must prove the reviewer's broker identity rather than accepting a
free-text agent name. The existing **Review** sidebar remains a *read-only* diff viewer; it
does not yet automatically dispatch reviewer chats or expose these integration operations.

## 3. Reversible code checkpoints

`src/main/checkpoints/` provides `createCodeCheckpoint`, `sealCodeCheckpoint` and
`restoreCodeCheckpoint`. A checkpoint explicitly names the files that belong to the task,
anchors them to a Git revision and captures their preimages. Sealing records the exact
postimages. Restore rechecks the repository/HEAD, index state and every owned postimage
**before** changing any file. It does not run `git reset`, `git clean` or rewrite unrelated
dirty files. A file edited by somebody else after sealing causes the restore to refuse.

These operations restore **local file contents**, not deployed websites, external API calls,
published commits or other irreversible effects. They are currently reusable internal APIs,
not a one-click timeline rewind control.

## 4. Independent scheduled-job daemon (explicit launch)

Build the standalone Node runtime after installing project dependencies:

```powershell
npm run daemon:build
```

The output is `out/mission-daemon.mjs` (generated, not committed). Start it **explicitly**,
using directories owned by your account:

```powershell
node out/mission-daemon.mjs serve --state-dir "D:\my-private-cos-jobs" --app-data "C:\Users\YOUR_USER\AppData\Roaming\chat-on-steroids"
```

The `--app-data` folder must match the **actual Electron `userData` folder** for the running
CoS installation. The app must have **Control API** enabled **and** **Allow actions** enabled
separately by the user. Neither setting is enabled automatically. Existing session IDs can
be discovered through the authenticated Control API; the daemon never invents a conversation.
Schedule a one-shot message in a second terminal (example ISO timestamp):

```powershell
node out/mission-daemon.mjs schedule --state-dir "D:\my-private-cos-jobs" --session "EXISTING_SESSION_ID" --text "Review the tests and report remaining failures" --at "2026-11-01T10:00:00+02:00"
node out/mission-daemon.mjs list --state-dir "D:\my-private-cos-jobs"
node out/mission-daemon.mjs cancel --state-dir "D:\my-private-cos-jobs" --id "JOB_UUID"
```

Recurring intervals use `--every-ms N`. Missed-run policy is `--missed fire-once` (default,
one pending catch-up occurrence) or `--missed skip --grace-ms N`. Every occurrence obtains a
stable, persisted outbox UUID before dispatch. Sends use the *existing* app Control API and
its outbox, so an uncertain HTTP reply is reconciled or left **unconfirmed**, never silently
resubmitted. Live permissions, target session ownership and browser availability are checked
at firing time. The daemon remains a separate local process even if the UI exits, but it
**cannot send or generate a ChatGPT answer while CoS/browser are unavailable**; due jobs remain
pending or are skipped according to policy. Stop the process with Ctrl+C.

The standalone daemon can be built and run from a source checkout. Automatic OS service
installation, GUI schedule management, packaged-app service registration and autonomous
provider-API execution are **not** part of this change.

## Testing and security boundaries

Focused regression suites: `test/worktrees-manager.test.ts`, `test/quality-gate.test.ts`,
`test/checkpoints-git.test.ts`, and `test/jobs-*.test.ts`/`test/daemon-*.test.ts`.
All persistent state and managed worktrees must remain scoped to approved resources.
Operational checks include `npm run typecheck`, `npm run verify`, a standalone daemon build,
and a source review of both success and refusal paths.
