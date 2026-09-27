---
name: ship-check
description: Review changed code in Thermal against the standards in CLAUDE.md before committing. Catches the judgment-dependent problems that scripts/slop-check.sh cannot - comments that restate code, speculative abstraction, padded structure, weak errors, tests that assert nothing. Use before any commit or when asked to review a diff for production readiness.
---

# ship-check

A reviewer's pass over changed code. `scripts/slop-check.sh` handles the mechanical rules; this handles the ones needing judgment.

Run `scripts/slop-check.sh` first. If it fails, fix that before starting here.

## How to run it

Review the diff (`git diff` for unstaged, `git diff --cached` for staged, or the files named by the user). Read the changed code in full, not just the hunks - a hunk can look fine inside a file that has gone wrong.

Report findings as a list, most serious first. For each: file:line, what is wrong, and the concrete fix. If nothing is wrong, say so plainly and stop. Do not invent findings to appear thorough.

## What to look for

**Comments that restate code.** Every comment must explain why, not what. `// loop through findings` above a loop over findings is deletion, not rewording. A comment needed to explain what a block does means the block should be clearer.

**Speculative abstraction.** An interface with one implementation. A parameter no caller passes. A config option nothing sets. An `options` object with one field. Generic names (`handle`, `process`, `manage`) that signal the author did not know what the thing was for. The two plug points in SPEC.md are the sanctioned exceptions.

**Padded structure.** Functions split for the sake of splitting, each called once from the line above. Wrappers that forward arguments unchanged. A file of 200 lines that says 40 lines of things.

**Defensive noise.** Null checks on values that cannot be null. Validation of arguments from internal callers. try/catch around code that does not throw. Defaults for required parameters. Each one costs a reader real attention and buys nothing.

**Weak errors.** Any user-reachable error that does not say what failed, what was being attempted, and what to do next. Check that malformed session files are treated as an expected case - truncated and half-written JSONL is normal input for this tool, not an exception.

**Tests that assert nothing.** Tests named `works correctly`. Tests asserting a mock was called when the call is not the contract. Tests mirroring the implementation line by line, which break on every refactor and catch no bugs. Detectors missing a negative fixture: a false positive about someone's money is worse than a miss.

**Dead weight.** Unused exports, unreferenced files, dependencies added for one call that the standard library covers. Each dependency is download weight on first `npx` run.

**Overlong names.** `detectedFindingResultsList` where `findings` reads better. Domain vocabulary should be exact (prefix, breakpoint, TTL, cache read) and everything else should be short.

**Prose voice.** README and CLI text: declarative and specific, numbers over adjectives. No launch-announcement register.

## Before approving

Confirm each, and say which ones you actually ran rather than assumed:

- `npm run build` compiles clean, with nothing suppressed
- `npm test` passes
- `scripts/slop-check.sh` is clean
- The code was run against real session data and the output was inspected
- The diff has been re-read as a reviewer, with habit-additions removed

A build you did not run is not a passing build. If a step failed, report the failure and its output.
