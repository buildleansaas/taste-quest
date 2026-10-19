# taste-quest: design tokens (iteration 1)

These tokens were pulled from qloo.com's production CSS on Oct 19, 2026. The site is built with Astro and Tailwind v4, and the sources were `/_astro/BaseLayout.BBMho1Re.css`, `/_astro/index.6WtKdfmd.css`, `/_astro/geo.8im8OWMj.css`, `/favicon.svg` and the header SVG logo. Raw copies are in `research/`. Everything is implemented in `tokens.css`.

## What makes it feel like Qloo
- **Warm paper, cool ink.** The page is `#f8f6f4` (surface), not white, and text is blue-grey ink `#28323c`. Cards are white or `#fcfaf8`, with soft centered shadows and no borders.
- **One quiet accent.** Lilac `#8c8cc8` is the bar over "oo" in the wordmark and the tail of the favicon. It's used for primary pill buttons, focus rings and our route line. Hover is `#8081b7`.
- **Plum for meaning.** Statement and lede copy uses plum `#785064`, and soft section heads use taupe `#b4aaa0` / `#a0968c`. That's where our "Why this fits you" text sits.
- **Dark aurora hero.** A near-black card with blurred teal (`#668794`) and violet glows, radius 24px. The panel gradient is `#162029 → #323c46 → #4d5761`.
- **Pills everywhere.** Buttons and chips are `rounded-full`. The site's geo-demo chip is a white 32px pill with `shadow-control` and a 10px color dot; we reused it for map overlays.

## Color (hex)
- **Surfaces:**
  - surface `#f8f6f4`
  - raised `#fcfaf8`
  - alt `#f2f0ee`
  - deep `#f0eeec`
  - cream `#e8e6e4` (secondary button)
  - hairline `#e0ded9`
- **Text:**
  - ink `#28323c`
  - slate `#505a64`
  - slate-dim `#78828c`
  - slate-soft `#a0aab4`
  - taupe `#b4aaa0`
- **Accent:**
  - `#8c8cc8`
  - hover `#8081b7`
  - deep `#6f6fba`
  - ring `#8c8cc852`
  - plum `#785064`
  - flare `#fa7850`
- **Night:** `#1e2328`, card `#181e23`.
- **Taste categories**, from the site's `--color-taste-*`:
  - artists `#774ab5` on `#ece5fb`
  - film `#a34414` on `#fdf0da`
  - places `#486a75` on `#dff3f8`
  - cuisine: Qloo's "brands" pair, `#70611a` on `#fbf0dc`
  - vibes: Qloo's "enrich" pair, `#8a4a62` on `#f7eaef`
- **Map** (Qloo geo and locality palettes):
  - land `#f8f4f0`
  - buildings `#e2ddd8`
  - roads `#fff`
  - park `#cfdcc6`
  - water `#d7e1e8` (Qloo's muted locality water; their geo demo uses `#a8d4f5`)

## Type
- **Display:** Circular Std (Lineto, licensed; qloo.com self-hosts Book and Bold). Our free fallback is **Figtree**, which has a similar geometric shape and a single-story feel. Weights 500–600, tracking −0.01em.
- **Body:** **Inter Variable** (free, and the font Qloo actually uses). **Mono:** **Fira Code** (free; Qloo uses it for labels, with tracking 0.16em).
- **Scale** (rem / line-height):
  - display 4.5/5.5
  - lede-lg 2.25/3.5
  - h2-band 2.5/3.5
  - h2-lg 2/2.5
  - h2 1.5/2
  - h3 1.25/1.75
  - lead 1.0625/1.75
  - card-head 1.0625/1.5625
  - body 0.9375/1.5
  - sm 0.875
  - meta 0.8125
  - field-label 0.6875
- **Mobile mapping** (px): hero 40/46, screen title 30/36, sheet title 24/30, body 15/22, meta 12–13.
- Eyebrows are uppercase 11px, weight 600, tracking 0.14em. Qloo's eyebrow token is 0.3em, which we tightened for mobile.

## Space, radius, elevation, motion
- **Spacing:** 4px base (Tailwind `--spacing:.25rem`). Screen gutters are 24px and gaps 8, 10 or 16px.
- **Radius:**
  - md 6px
  - lg/field 8px
  - xl 12px
  - panel 14px
  - card 24px (hero, sheets)
  - full (buttons, chips)
- **Shadows** (all centered and soft):
  - control-sm `0 0 8px #00000029`
  - control `0 0 12px #0000001f`
  - card `0 0 24px #00000014`
  - pop `0 0 32px #00000014`
  - lift `0 0 48px #00000014`
  - float `8px 8px 48px #00000014`
- **Motion:**
  - ease `cubic-bezier(.4,0,.2,1)`, 150ms for color changes
  - map fade-in 550ms, fade-out 300ms
  - `live-pulse`: scale 1 → 2.6 while opacity goes .7 → 0, used for the user dot
  - slow ambient "dot drift" (7px over 9–20s)
  - Nothing bouncy.

## Buttons and cards
- **Primary:** accent fill, white text, 48px tall (Qloo uses 32px with `text-sm` on desktop), pill.
- **Secondary:** cream `#e8e6e4` fill with ink text. Qloo's "Book a Demo" nav button is `bg-cream text-ink hover:bg-hairline`.
- **Ink button:** for Apple sign-in. **White button:** inset 1px hairline.
- **Cards:** white, radius 24 (or 14 for list panels), `shadow-card`, no border.
- **Fields:** white, radius 8, 1px hairline. On focus, a 1px accent line plus a 4px accent ring.

## Logo treatment
- The wordmark "Qloo" is ink `#28323C`, with a lilac `#8C8CC8` bar spanning the "oo".
- The favicon is a ring with a 45° lilac tail (a magnifier/Q).
- We use the real wordmark only in "Taste intelligence by Qloo" credits. The taste-quest mark borrows the ring, with a lilac dot in the center to suggest a "you are here" pin. It is not Qloo's logo.
