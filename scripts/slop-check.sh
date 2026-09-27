#!/usr/bin/env bash
# Mechanical checks for the patterns banned in CLAUDE.md.
# Judgment-dependent rules (comment quality, speculative abstraction) are not
# checkable here - use the ship-check skill for those.
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
report() { printf '\n%s\n' "$1"; fail=1; }

# Lines marked "slop-ok: <reason>" are exempt from every check. Use sparingly
# and always with a reason.
filter_ok() { grep -v 'slop-ok' || true; }

src_globs=(-g '*.ts' -g '*.tsx' -g '*.js' -g '*.mjs')
doc_globs=(-g '*.md')
all_globs=("${src_globs[@]}" "${doc_globs[@]}")
skip=(-g '!node_modules' -g '!dist' -g '!*.lock')

# Emoji. Ranges cover pictographs, dingbats and variation selectors but leave
# typographic arrows (U+2192) alone, which are legitimate in prose.
if out=$(rg -n --pcre2 '[\x{1F000}-\x{1FAFF}\x{2600}-\x{27BF}\x{FE0F}]' "${all_globs[@]}" "${skip[@]}" . 2>/dev/null | filter_ok) && [ -n "$out" ]; then
  report "Emoji found:"; echo "$out"
fi

# Banner comments.
if out=$(rg -n '^\s*//\s*[=*-]{4,}|^\s*//\s*[A-Z][A-Z ]+\s*[=-]{3,}' "${src_globs[@]}" "${skip[@]}" . 2>/dev/null | filter_ok) && [ -n "$out" ]; then
  report "Banner comments (split the file instead):"; echo "$out"
fi

# Marketing voice in docs.
if out=$(rg -ni '\b(blazingly|seamless(ly)?|effortless(ly)?|simply run|just run|that.s it!|supercharge|game.chang|cutting.edge|state.of.the.art)\b' "${doc_globs[@]}" "${skip[@]}" -g '!CLAUDE.md' . 2>/dev/null | filter_ok) && [ -n "$out" ]; then
  report "Marketing voice in docs:"; echo "$out"
fi

# Bare `any`.
if out=$(rg -n ':\s*any\b|<any>|as any\b' "${src_globs[@]}" "${skip[@]}" . 2>/dev/null | filter_ok) && [ -n "$out" ]; then
  report "Bare 'any' (use unknown and narrow):"; echo "$out"
fi

# Empty catch.
if out=$(rg -n --pcre2 'catch\s*(\([^)]*\))?\s*\{\s*\}' "${src_globs[@]}" "${skip[@]}" . 2>/dev/null | filter_ok) && [ -n "$out" ]; then
  report "Empty catch block:"; echo "$out"
fi

# TODOs without an issue reference.
if out=$(rg -n --pcre2 '(TODO|FIXME|XXX)(?!.*#\d+)' "${src_globs[@]}" "${skip[@]}" . 2>/dev/null | filter_ok) && [ -n "$out" ]; then
  report "TODO without issue reference (do it, file it, or delete it):"; echo "$out"
fi

# console.* outside the reporting boundary.
if out=$(rg -n 'console\.(log|info|warn|error)' "${src_globs[@]}" "${skip[@]}" -g '!src/report/**' -g '!scripts/**' . 2>/dev/null | filter_ok) && [ -n "$out" ]; then
  report "console.* outside src/report (route output through the reporter):"; echo "$out"
fi

if [ "$fail" -eq 0 ]; then
  echo "slop-check: clean"
else
  printf '\nslop-check: %s\n' "failures above"
fi
exit "$fail"
