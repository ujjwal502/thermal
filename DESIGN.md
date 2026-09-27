# Thermal — design system

The visual counterpart to `CLAUDE.md`. Read before writing any UI.

## The direction: instrument, not dashboard

Thermal is a measuring instrument — an oscilloscope, a thermal camera, a flight gauge. Not a SaaS dashboard. Every decision below follows from that.

Five committed moves:

1. **One typeface, monospace, dramatic scale contrast.** No sans. No serif. Hierarchy from size and weight alone.
2. **A colorless interface around colored data.** Chrome is monochrome. The thermal ramp appears only where it carries meaning.
3. **Rules, not cards.** Hairline dividers and a strict grid. Nothing floats, nothing has a shadow.
4. **Almost no motion.** One exception, below.
5. **Signature detail:** because the UI is otherwise gray, any color on screen is information. Color density *is* the diagnosis — a screen with amber across it is healthy, a screen streaked with blue is losing money. You read the verdict before reading a single number.

## Color

Dark surface only in v1. This is a deliberate choice for a terminal-adjacent tool, not an unfinished light mode. A light theme must be separately stepped from the same hues and re-validated against a light surface — never auto-inverted.

### Tokens

```css
:root {
  --surface-0:      #0a0a0b;   /* page */
  --surface-1:      #121214;   /* raised region */
  --surface-2:      #1a1a1d;   /* hover, input */
  --rule:           #232327;   /* hairline dividers */

  --text-primary:   #e8e8e6;
  --text-secondary: #9a9a98;
  --text-muted:     #5f5f63;

  /* Thermal diverging ramp - cache state. Cold = recomputed = expensive.
     Hot = cached = cheap. Both arms validated against #0a0a0b. */
  --cold-3:         #4fc3e0;   /* coldest - full recompute */
  --cold-2:         #2f9dc4;
  --cold-1:         #3f7f9e;
  --neutral:        #55555c;   /* midpoint - no cache activity */
  --hot-1:          #9e7434;
  --hot-2:          #c9912c;
  --hot-3:          #eeb03e;   /* hottest - full cache hit */

  --critical:       #e04b57;   /* reserved - severity only, never data */
}
```

### Rules

- **The ramp is diverging, not sequential.** Cache state has polarity: two hues, a neutral gray midpoint, equal steps per arm. It is never a rainbow and never spans more hues than these.
- **The ramp is reserved for cache state.** Not for categories, not for decoration, not for a button.
- **`--critical` is reserved for severity** and never appears in a chart. It always ships with a glyph and a word, never as color alone.
- **Severity has no other colors.** Warning and info are typographic — weight, position, and the dollar figure carry them. Three-colour severity scales fail colour-distance checks and add nothing here.
- **Text always wears text tokens.** A value is never painted in a series color; a colored mark sits beside it.
- **The neutral midpoint sits at 2.68:1 against the surface** — below the 3:1 threshold. Any neutral segment must carry a visible label or appear in the table view. This is not optional.

### Validation

Both arms pass the data-viz validator as ordinal ramps against `#0a0a0b`: monotone lightness, step gaps above 0.06, light end clearing the surface, hue spread 14° (cold) and 3° (hot). Re-run after any change:

```
node <dataviz>/scripts/validate_palette.js "#3f7f9e,#2f9dc4,#4fc3e0" --mode dark --surface "#0a0a0b" --ordinal
```

Do not run the categorical checks against the full ramp — a diverging ramp fails them by design.

## Typography

**Iosevka** (SIL OFL), single face, all weights. Chosen for a functional reason: it is narrow, so more columns of numeric data fit per row, which is the whole job. Alternate: Commit Mono. Verify license before shipping either.

Explicitly not: Inter, system-ui, Roboto, Geist, Space Grotesk, JetBrains Mono. The first three are the AI default; the last three are the *second-order* default — the fonts people pick to look non-default, which made them default.

```
display    72px / 600 / -0.03em    the waste figure, once per screen
heading    18px / 600 / -0.01em    section labels, uppercase, tracked +0.08em
body       13px / 400              prose, findings text
data       13px / 400 / tabular    all numerals - tabular-nums always
label      11px / 500 / +0.06em    axis ticks, column heads, uppercase
```

- `font-variant-numeric: tabular-nums` on every number without exception. Columns must align.
- One display figure per screen. Two competing hero numbers means neither is the headline.
- Uppercase only for labels under 12px. Never for prose.

## Layout

- **8px base grid.** Spacing steps: 4, 8, 12, 16, 24, 40, 64. Nothing between.
- **No cards.** Regions separate by a 1px `--rule` and whitespace. No border radius above 2px, no shadows, no glass, no gradients anywhere.
- **Dense by default.** Table rows 28px. This is a tool for reading many numbers at once; airiness is a cost, not a virtue.
- **Numeric columns right-aligned**, labels left-aligned, dollar figures in their own column.
- **Full width.** No `max-width` centering. The instrument fills its housing.

## Components

**Stat block** — label above, figure below, no container. The waste figure gets display size, a thermal-tinted underline whose color reflects overall health, and nothing else.

**Context X-ray** — one horizontal bar, full width, 32px tall. Segmented left to right in true render order: tools, system, messages. Position and a direct label carry identity; the thermal ramp carries cache state only. 2px surface gap between segments. Segments under 40px wide take an external label with a leader line rather than shrinking the text.

**Findings row** — a table row, not a card. Columns: detector ID (muted mono), title, location (secondary), dollar figure (right-aligned, primary weight). Critical rows take a `--critical` glyph in the gutter and the word "critical" — never a red row background.

**Sparkline** — 2px stroke, single hue, no fill, no axis, no grid. A bare trend. Hover exposes a crosshair and a value tooltip.

**Timeline ribbon** — one cell per turn, thermal-colored by that turn's cache state. The turn where the cache broke gets a 1px `--critical` vertical rule and a caption. This is the view that makes the bug obvious without reading anything.

## Interaction

- **Every chart is interactive.** Crosshair plus tooltip on line and area; per-mark tooltip on bar, cell, and ribbon. Hit targets larger than the marks.
- **Filters in one row above the content**, never in a sidebar.
- **Every view has a table equivalent**, reachable by keyboard. This is the accessibility relief for the low-contrast neutral and for anyone who cannot use the ramp.
- Keyboard: `j`/`k` to move, `/` to search, `?` for help, `enter` to drill in.

## Motion

Effectively none. Transitions at 120ms ease-out on hover and focus only.

The single exception: **on first paint, the waste figure counts up from zero over ~600ms, like a gauge settling.** Once, on load, never again. It earns its place because it is the one moment the product is making a claim.

No fade-in-up on scroll. No staggered card reveals. No skeleton shimmer — show the real row count and fill it.

## Do not

Drawn from the AI-tells catalog, scoped to this project:

- Purple, indigo, violet, or any gradient. Gradient text especially.
- Inter, system-ui, or an unpaired default sans.
- `rounded-2xl`, `shadow-lg`, or any elevation on a surface.
- Glassmorphism, blur, translucency.
- A centered hero with a headline over a subhead over two buttons.
- Three feature cards in a row.
- Emoji as icons, or emoji at all.
- Lucide icons at default weight and size used decoratively. Icons appear only where they carry meaning (severity), never as ornament.
- A colored progress ring or donut for a percentage. Use a number.
- "Elevate", "Supercharge", "Effortless" — see `CLAUDE.md` voice rules. <!-- slop-ok: names the banned vocabulary in order to ban it -->

## Before shipping any screen

1. Render it and look at it. Layout errors are invisible in source.
2. Run the `avoid-ai-design` skill in detect mode. Fix every P0 and P1.
3. Re-run the palette validator if any color changed.
4. Check it at 1280px and at 1920px. Check one view with a single session and with all of them.
5. Confirm every number is tabular and every column aligns.
6. Screenshot it. If it could be any other dev tool, the direction has not been executed.
