# Argonav — UI Design System

A clean, editorial, "system-intelligence" aesthetic: airy light-gray canvas, near-black
display type, thin hairline rules, generously rounded glass cards, and a restrained
steel-blue / sky-cyan accent. Typography does the heavy lifting; color is quiet.

> Fonts and design tokens below are extracted from the live site
> (`https://argonav-site.vercel.app/`). Sizes marked _(est.)_ are read from the reference
> screenshot — the site's exposed Tailwind type scale tops out at `text-4xl`, so hero
> display sizes are inferred.

---

## 1. Typography

### Font families

| Role | Family | Stack |
|------|--------|-------|
| **Display / Headings** | **Plus Jakarta Sans** | `"Plus Jakarta Sans", "Jakarta Fallback", -apple-system, system-ui, sans-serif` |
| **Body / UI** | **Plus Jakarta Sans** | `"Plus Jakarta Sans", "Jakarta Fallback", -apple-system, system-ui, sans-serif` |
| **Mono / Labels / Numerals** | **Fragment Mono** | `"Fragment Mono", "SF Mono", ui-monospace, monospace` |

Display and body share one family — hierarchy comes from **size, weight, and tracking**, not
from a second typeface. Fragment Mono is reserved for "machine" moments: the `KEEL` badge,
the `01–04` station numerals, and all-caps eyebrow labels.

### Web font files (self-hosted, `woff2`, `font-display: swap`)

```
/fonts/PlusJakartaSans-Light.woff2     → Plus Jakarta Sans 300
/fonts/PlusJakartaSans-Regular.woff2   → Plus Jakarta Sans 400
/fonts/PlusJakartaSans-Medium.woff2    → Plus Jakarta Sans 500
/fonts/fragment-mono-400.woff2         → Fragment Mono 400
/fonts/fragment-mono-400-ext.woff2     → Fragment Mono 400 (Latin-ext subset)
```

**Metric-matched fallback** to prevent layout shift before the web font loads:

```css
@font-face {
  font-family: "Jakarta Fallback";
  src: local(Arial);
  ascent-override: 96.8%;
  descent-override: 24.2%;
  line-gap-override: 0%;
  size-adjust: 106.3%;
}
```

### Weights in use

`300` Light · `400` Regular · `500` Medium. **No bold.** Headlines render at Light/Regular
at large sizes — the airiness is intentional. Fragment Mono ships at `400` only.

### Type scale & tracking

Display type uses **tight negative tracking**; small all-caps labels use **wide positive
tracking**. This contrast is a signature of the system.

| Token | Size | Use | Weight | Tracking |
|-------|------|-----|--------|----------|
| Display XL _(est.)_ | ~56–64px / 3.5–4rem | Hero headline ("One substrate…") | 300–400 | `-0.035em` to `-0.04em` |
| `text-4xl` | 2.25rem (36px) | Section headline | 400 | `-0.025em` |
| `text-3xl` | 1.875rem (30px) | Sub-headline | 400 | `-0.02em` |
| Card title _(est.)_ | ~22–24px | Feature-card titles | 400 | `-0.018em` |
| Body _(est.)_ | ~17–19px | Lead paragraph | 400 | `-0.01em` |
| `text-sm` | 0.875rem (14px) | Card body, meta | 400 | `-0.005em` |
| `text-xs` | 0.75rem (12px) | Eyebrow labels (caps) | 500 | **`+0.12em` to `+0.14em`** |
| Station numeral _(est.)_ | ~44–52px | `01`–`04` (Fragment Mono) | 400 | `0` |

```css
:root {
  --font-family-display: "Plus Jakarta Sans", "Jakarta Fallback", -apple-system, system-ui, sans-serif;
  --font-family-body:    "Plus Jakarta Sans", "Jakarta Fallback", -apple-system, system-ui, sans-serif;
  --font-family-mono:    "Fragment Mono", "SF Mono", ui-monospace, monospace;
}

/* Hero display */
.display {
  font-family: var(--font-family-display);
  font-weight: 400;
  letter-spacing: -0.035em;
  line-height: 1.05;
  color: var(--ink);
}

/* All-caps accent eyebrow ("ONE PLATFORM. FOUR BUSINESSES. ALL REINFORCING.") */
.eyebrow {
  font-family: var(--font-family-mono);
  font-size: 0.75rem;
  font-weight: 500;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--accent-ink);
}
```

---

## 2. Color

Apple-grade neutral system: warm-leaning blacks, platinum grays, and a two-tone blue accent
(**steel** for ink-on-light, **sky-cyan** for glow / dark surfaces).

### Light theme (primary — matches the screenshot)

| Role | Token | Hex |
|------|-------|-----|
| Canvas (base) | `--color-light-bg` | `#ffffff` |
| Canvas (panel) | `--color-light-bg-2` | `#f5f5f7` |
| Canvas (sunk) | `--color-light-bg-3` | `#e5e5ea` |
| Ink (display) | `--color-light-ink` | `#1c1c1e` |
| Ink (body / soft) | `--color-light-ink-soft` | `#2c2c2e` |
| Ink (muted / meta) | `--color-light-ink-muted` | `#aeaeb2` |
| Faint (big numerals) | `--ink-300` | `#c7c7cc` |
| Hairline rule | `--color-light-rule` | `#1c1c1e1f` _(12% black)_ |
| Border | `--border` | `#e3e3e8` |

### Accent

| Role | Token | Hex | Notes |
|------|-------|-----|-------|
| Accent ink (labels, links) | `--accent-ink` | `#2a6fa8` | Steel blue — the eyebrow label color |
| Atmosphere / glow | `--atmosphere-blue` | `#7dd2f3` | Sky cyan — dark-mode accent, beacons |
| Beacon glow | `--beacon-glow` | `#7dd2f38c` | Translucent cyan halo |
| Beacon tint | `--beacon` | `#eaf6fc` | Palest cyan wash |

### Dark theme (deep "space-blue" inverse)

| Role | Token | Hex |
|------|-------|-----|
| Canvas | `--color-dark-bg` / `--space-blue` | `#0b1a2d` |
| Canvas (deeper) | `--space-blue-900` | `#060f1c` |
| Surface (carbon) | `--color-dark-bg-black` | `#1c1c1e` |
| Ink | `--color-dark-ink` | `#ffffff` |
| Ink (dim) | `--color-dark-ink-dim` | `#aeaeb2` |
| Accent | `--color-dark-accent` | `#7dd2f3` |
| Rule | `--color-dark-rule` | `#ffffff1a` _(10% white)_ |
| Rule (strong) | `--color-dark-rule-strong` | `#ffffff3d` _(24% white)_ |

### Space-blue ramp (for gradients / depth)

```
--space-blue-600: #1b3149
--space-blue-700: #112439
--space-blue-800: #0b1a2d
--space-blue-900: #060f1c
```

```css
:root {
  --ink:        #1c1c1e;   /* display */
  --ink-soft:   #2c2c2e;   /* body */
  --ink-muted:  #aeaeb2;   /* meta */
  --ink-faint:  #c7c7cc;   /* huge numerals */
  --bg:         #ffffff;
  --bg-panel:   #f5f5f7;
  --rule:       #1c1c1e1f;
  --accent-ink: #2a6fa8;
  --atmosphere: #7dd2f3;
}
```

---

## 3. Surfaces — radius, shadow, glass

### Radius

The token scale is small (`--radius-sm: .25rem`, `--radius-md: .375rem`), but **hero
surfaces round much harder**. Observed component radii:

| Surface | Radius |
|---------|--------|
| Buttons / chips / badges | 4–6px (`--radius-sm`/`md`) |
| Feature-card grid container | ~16px (`rounded-2xl`) |
| Hero figure card (mandala) | ~24px (`rounded-3xl`) _(est.)_ |

### Shadow (branded, cool `#101014` tint — not pure black)

```css
--shadow-sm: 0 1px 2px  #1010141a, 0 1px 3px  #10101412;
--shadow-md: 0 8px 24px #1010141f, 0 2px 8px  #10101412;
--shadow-lg: 0 30px 70px #10101438, 0 10px 26px #1010141f;  /* hero figure card */
```

The large white card in the hero (the geometric pentagon figure) sits on `--shadow-lg`:
a tall, soft, low-opacity drop that reads as "floating glass" against the gray canvas.

### Glass

```css
--glass-bg-light:     #ffffff9e;  /* ~62% white */
--glass-border-light: #14141814;  /* ~8% black hairline */
--glass-border:       #ffffff29;  /* dark-mode inner border */
```

### Atmospheric gradients

```css
--chromatic-stop-1: #9fcfdfd9;
--chromatic-stop-2: #b3d5e6a6;
--chromatic-stop-3: #cfafca8c;
--chromatic-gradient-h: linear-gradient(90deg,
  var(--chromatic-stop-1) 0%, var(--chromatic-stop-2) 50%, var(--chromatic-stop-3) 100%);
```

The page canvas itself is a near-white vertical wash (`#f5f5f7` → `#ffffff`) with a faint
cool tint toward the top — keep it subtle.

---

## 4. Motion

```css
--motion-ease-veil: cubic-bezier(0.4, 0, 0.2, 1);
```

Single shared easing for reveals/transitions ("veil" = fade + slight rise). Keep durations
calm (200–500ms); the brand reads as precise and unhurried.

---

## 5. Component anatomy (from the reference)

### Hero block (two-column)

- **Left column:** display headline → lead paragraph (muted) → steel-blue all-caps eyebrow →
  text link with arrow.
- **Right column:** floating white `rounded-3xl` card (`--shadow-lg`) containing a thin
  line-art geometric figure (pentagon mandala). Stroke ≈ 0.5–0.75px, color `--ink` at low
  opacity / `--ink-muted`. No fill.

**Inline mono badge** (`KEEL`): Fragment Mono, uppercase, `--ink`, sitting in a pill with a
1px `--border` outline and `--radius-sm`. Used mid-sentence as a "product token."

**Text link** ("Our approach →"): body weight, `--ink`, trailing `→` glyph. Underline on
hover; arrow nudges right on hover.

### Feature cards (`01`–`04`)

Four equal columns inside one `rounded-2xl` panel, separated by **single vertical hairlines**
(`--rule`, 1px). Each card:

```
┌──────────────────────────────┐
│  01                    ⌁ icon │   ← numeral: Fragment Mono, ~48px, --ink-faint (#c7c7cc)
│                               │     icon: 1px line, --ink-muted, top-right
│  Agentic frontier             │   ← title: Plus Jakarta Sans 400, ~22px, --ink, tracking -0.018em
│  industrialists               │
│                               │
│  We lead the way in system    │   ← body: text-sm (14px), --ink-soft, line-height ~1.5
│  efficiency across the …      │
└──────────────────────────────┘
```

- Numeral and icon share the top row (numeral left, icon right).
- Title sits below with clear gap; body below that.
- Icons are thin, single-weight line glyphs (wifi, layers, share-node, route) in `--ink-muted`.
- Card padding ≈ 28–32px; hairline rules run full card height.

```css
.feature-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  border: 1px solid var(--rule);
  border-radius: 16px;
  background: var(--bg);
}
.feature-card { padding: 32px; }
.feature-card + .feature-card { border-left: 1px solid var(--rule); }

.feature-card__num {
  font-family: var(--font-family-mono);
  font-size: 3rem;
  color: var(--ink-faint);
  line-height: 1;
}
.feature-card__title {
  font-weight: 400;
  font-size: 1.375rem;
  letter-spacing: -0.018em;
  color: var(--ink);
  margin: 1.25rem 0 0.5rem;
}
.feature-card__body {
  font-size: 0.875rem;
  line-height: 1.5;
  color: var(--ink-soft);
}
```

---

## 6. Principles

1. **One typeface, three jobs.** Plus Jakarta Sans for everything human; Fragment Mono for
   anything that reads as a system token, number, or label.
2. **Hierarchy by tracking, not weight.** Big = light + tight; small caps = wide. Avoid bold.
3. **Quiet color.** Near-black ink on near-white canvas. Blue appears only as labels, links,
   and atmospheric glow — never as large fills in the light theme.
4. **Hairlines over boxes.** Separate with 1px `--rule` lines and whitespace before reaching
   for borders or shadows.
5. **Float the figure.** Imagery/diagrams live on a single hero card with a tall soft
   `--shadow-lg`; everything else stays flat on the canvas.
6. **Generous air.** Roomy padding, calm motion (`--motion-ease-veil`), no visual noise.
