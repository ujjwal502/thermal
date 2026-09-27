# Thermal — engineering standards

Read this before writing code. It is not style preference; it is the quality bar.

## Context

Thermal is a local-first CLI that analyzes AI agent session logs and reports where prompt caching broke and what it cost. TypeScript, Node 20+, distributed via `npx`. See `SPEC.md`.

## Prime directive

**Write code a senior engineer would write, then ship.** Not code that demonstrates thoroughness. Not code that anticipates every hypothetical. Code that solves the problem at hand and reads like someone thought about it once, carefully.

The tells that mark code as machine-written and the tells that mark it as junior work are the same list: over-commenting, speculative abstraction, defensive noise, uniform shapeless structure. Removing them is not cosmetic — it is the difference between a pet project and something people trust enough to run against their own data.

## Banned outright

These are mechanical. `scripts/slop-check.sh` catches most of them; it runs in CI and the answer to a hit is to fix the code, never to weaken the check.

- **Emoji.** Not in source, comments, logs, CLI output, commits, or docs. Zero.
- **Banner comments.** `// ===== HELPERS =====`, `// ---- Types ----`. If a file needs internal signposting, it needs splitting.
- **Comments that restate code.** `// increment the counter` above `counter++`. Delete on sight.
- **JSDoc on self-evident functions.** `/** Gets the user. @returns The user */` is worse than nothing.
- **Marketing voice in docs.** "Blazingly fast", "simply run", "just do X", "That's it!", "powerful", "seamless", "comprehensive". Say what it does.
- **Progress narration.** `console.log("Starting analysis...")` scattered through logic. Use the reporter, once, at the boundary.
- **`any`.** Use `unknown` and narrow. If you genuinely need `any`, write one line saying why.
- **Catch-log-rethrow.** A catch block that adds no information is noise. Either handle it or let it propagate.
- **Speculative `async`.** No `async` on a function that never awaits.
- **`utils.ts`.** Name modules for what they contain. A dumping ground attracts garbage.
- **Placeholder TODOs.** Either do it, file an issue and reference it by number, or delete it.

## Comments

Comment the **why**, never the what. Good comments explain a decision, a constraint, a gotcha, or a link to evidence:

```ts
// Anthropic renders tools -> system -> messages, so a tool change invalidates
// everything downstream. Detect it before the cheaper system-prompt check.
```

Bad:

```ts
// Loop through the tools
for (const tool of tools) {
```

If a comment is needed to explain *what* a block does, the block is wrong. Fix the code.

## Abstraction

Introduce an abstraction when you have **two or three real call sites**, not one and a hypothesis. Wrong abstractions cost more than duplication.

The two plug points in `SPEC.md` (agent adapters, provider analyzers) are the deliberate exceptions — they are designed for extension because we know more implementations are coming. Everything else starts concrete.

No factories, managers, `BaseAbstract*`, or interfaces with one implementation.

## Errors

Every error a user can hit must say what went wrong, what Thermal was doing, and what to do next.

```ts
// Good
throw new Error(
  `No session files found in ${dir}. Thermal reads Claude Code logs from ` +
  `~/.claude/projects. Run 'thermal --help' for supported agents.`
)

// Bad
throw new Error("Not found")
```

Never swallow an error silently. Never `catch {}`.

This tool reads files that sit next to people's source code. A crash with a stack trace on their private data is a trust failure, not just a bug. Handle malformed input as an expected case — session files will be truncated, interrupted, and half-written, and that is normal, not exceptional.

## Structure

- Files vary in length because problems do. A codebase where every file is 200 lines has been padded or fragmented.
- One export per file is a rule for libraries, not for us. Group what belongs together.
- Keep the hot path flat. Parsing hundreds of megabytes means the parser is allowed to be uglier and faster than the rest of the code — and it gets a comment saying so.

## Naming

Short, conventional, domain-accurate. `findings`, not `detectedFindingResultsList`. `parse()`, not `parseSessionFileContents()` when it lives in `session-file.ts`.

Use the domain's real vocabulary: prefix, breakpoint, TTL, cache read, cache write, invalidation. Someone who knows prompt caching should recognise the nouns.

## Tests

Test behavior that can break, with real data. We have hundreds of genuine session files — use fixtures drawn from them, redacted.

- Names state the behavior: `test('reports zero waste when cache reads are stable')`, not `test('works correctly')`.
- No tests asserting that a mock was called, unless the call itself is the contract.
- Every detector gets a fixture that triggers it and a fixture that must not trigger it. False positives are worse than misses here — a tool that cries wolf about money gets uninstalled.
- Don't mirror the implementation. If the test changes every time the code is refactored, it tests structure, not behavior.

## Dependencies

Each one is a liability in a tool people run with `npx` — it is download weight on first run. Justify additions in the PR. Prefer the standard library. Node 20+ gives us most of what we need.

## Git

- Commit messages: imperative subject under 60 chars, body explaining *why* when it isn't obvious. No "feat: implement comprehensive solution for parsing".
- Small commits. A commit that touches the parser, the UI, and the pricing table is three commits.
- Commits are co-authored with Claude. This is honest and normal; it does not lower the bar for what gets committed.

## Docs and CLI voice

Plain, declarative, specific. Write like documentation, not like a launch announcement.

- "Thermal reads session logs from `~/.claude/projects` and reports cache waste." — good.
- "Thermal is a powerful tool that seamlessly analyzes your AI workflows!" — delete.

Numbers over adjectives. "Parses 181 sessions in 0.8s" beats "fast".

## Before claiming anything is done

Run all of these. Do not report completion on the basis of having written code.

1. `npm run build` — compiles clean, no errors suppressed.
2. `npm test` — passes.
3. `scripts/slop-check.sh` — clean.
4. Actually run the thing on real sessions and look at the output.
5. Re-read the diff as a reviewer. Delete what you added out of habit rather than need.

If a step fails, say so with the output. Never report a passing build you did not run.
