Thanks @Maximapple, fixed in caa3afc.

**Windows line endings.** I kept restore following the user's Git settings. It writes through `cat-file --filters`, so a file comes back the way `git checkout` would write it, and the comparison hashes through the same filters, so the restored file shows no change. The test repository now sets `core.autocrlf false` for its byte assertions, and a new test sets `core.autocrlf true` and expects `\r\n` with an empty comparison afterwards. I reproduced the three Windows failures on Linux with `core.autocrlf=true` in the user config. They pass now.

**Codex findings**, both fixed with a test that fails without the fix:
- A capture that fails or times out marks the turn (bounded, in memory), so a later patch of that turn no longer takes a "before" checkpoint that already contains the first patch. The next turn checkpoints normally.
- Restore resolution accepts a missing suffix below the deepest existing folder, which is still checked for links. Parent folders removed since the checkpoint are recreated. This only applies to restore; other Files actions keep the missing-leaf rule.

AGENTS.md states both rules. `npm run verify` passes except the 2 `public-history-privacy` tests that also fail on `main` in my environment.
