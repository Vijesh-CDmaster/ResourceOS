# ResourceOS — Design System

> Status: Phase A of the Facility Operations OS build. Everything below is
> implemented in `app/globals.css` (tokens) and used by the components listed.
> Nothing here is aspirational styling that the product does not ship.

## 1. Principles

1. **Operational, not decorative.** Every visual element answers "what needs
   attention, and what do I do next?" If a chart or badge does not change a
   decision, it is removed.
2. **Evidence over assertion.** Numbers always carry their window, their source
   and — where it matters — the data that is missing.
3. **Density with air.** Staff read tables all day: rows are compact (12–14px
   text, 12px vertical rhythm), but sections are separated by generous space so
   the eye can land.
4. **Status is never colour alone.** Every badge carries a word; every warning
   carries a sentence and an action.
5. **Quiet chrome, loud data.** The shell recedes (deep neutral, no gradients);
   ink and money figures get the contrast budget.

## 2. Brand

- **Name:** ResourceOS. Wordmark set in the UI font, tight tracking, no icon lockup.
- **Voice:** precise, unexcited, specific. "Calibration expired on 12 Oct" — never
  "Something went wrong".
- **Personality:** a laboratory console, not a startup landing page. Trust is the
  product; the interface should look like it keeps records.

## 3. Colour tokens

Defined as CSS custom properties in `app/globals.css` (`@theme`), consumed through
Tailwind utilities (`bg-canvas`, `text-ink`, `border-line`, `bg-brand-700`).

| Token | Value | Use |
|---|---|---|
| `--color-canvas` | `#f7f6f3` | App background |
| `--color-surface` | `#ffffff` | Cards, tables, inputs |
| `--color-line` | `#e5e2da` | Hairline borders, table rules |
| `--color-ink` | `#17201d` | Primary text |
| `--color-muted` | `#6b7570` | Secondary text, labels |
| `--color-brand-50…900` | `#eef6f3` → `#0b2f2a` | Primary action, active nav, links |
| `--color-night` | `#0d1f1c` | Sidebar, deep panels |
| semantic green | `emerald-*` | Ready, confirmed, valid |
| semantic amber | `amber-*` | Warning, due soon, needs approval |
| semantic red | `red-*` | Blocked, expired, danger |

**Dark theme:** the sidebar and the Capital/readiness deep panels are already dark;
a full dark mode is deferred until the token surface is extracted (`--color-*`
duplication per theme). Not shipped, not claimed.

## 4. Typography

- **UI face:** Inter → system fallback (`--font-sans`). No display serif in product
  UI; the deck uses Georgia, the app does not.
- **Mono:** `--font-mono` for asset codes, IDs and certificate references.
- Scale (px): 10 eyebrow · 11 label/badge · 12 table meta · 13 table body/UI ·
  14 body · 16 section · 20 card title · 28 page title.
- Weights: 400 body, 500 labels, 600 headings. Never 700 in body copy.
- Page titles: 28px, `-0.02em` tracking. Section headings: 16px/600. Labels:
  11px uppercase, `0.08em` tracking.

## 5. Spacing

4px base. Practical steps: 4, 8, 12, 16, 20, 24, 32, 40. Cards use 20px padding
(`p-5`); section gaps 20px; page gutters 24px desktop / 16px mobile. Table cells
12px vertical, 16px horizontal.

## 6. Radii

`8px` controls and inputs · `10px` buttons · `16px` cards (`rounded-2xl`) ·
`999px` badges and chips. No mixed 6px/12px in the same view.

## 7. Elevation

- Flat by default (border + surface contrast).
- `shadow-[0_1px_0_rgba(23,32,29,0.02)]` on inputs only.
- Popovers/modals: `0 12px 32px -12px rgba(13,31,28,0.28)`, no blur layers.
- No glassmorphism, no gradients as decoration.

## 8. Iconography

Single line-icon set in `components/icons.tsx` (24px viewBox, 1.6 stroke,
`currentColor`). Names are semantic (`shield`, `wrench`, `coins`, `box`). Icons
never replace a word in a status badge; they accompany it.

## 9. Buttons

| Variant | Class | Use |
|---|---|---|
| Primary | `.btn-primary` | One per view: the next action |
| Secondary | `.btn-secondary` | Navigational/alternative actions |
| Ghost | `.btn-ghost` | Row-level, low-emphasis |
| Danger | `.btn-danger` | Destructive, always behind a confirm |

All buttons: 10px radius, 13px/600 text, 32px height, visible `:focus-visible`
ring (`ring-2 ring-brand-500/40`), disabled at 60% opacity.

## 10. Forms

Label above control (11px uppercase), control 32px, helper text 11px muted,
error text 11px red with the field still editable. Validation is server-side
first; the UI repeats the server message verbatim rather than inventing a new
one. Required fields are marked with a word, not an asterisk alone.

## 11. Tables

`.table` — 13px body, 11px uppercase header, hairline row rules, hover tint
`bg-brand-50/40`, numeric columns right-aligned and tabular. Emptied tables get
an `EmptyState` with one action, never a bare "No data".

## 12. Cards

`.card` / `.card-pad` — white, 1px `line`, 16px radius, 20px padding. A card
holds one idea: one metric, one record, one form. Readiness reasons are cards
because they carry a title, a sentence and an action.

## 13. Charts

Bars and meters only where a trend or a share is genuinely the question.
`Meter` is a 6px track with a brand fill and a numeric label; it never stands
in for an exact figure. No 3D, no gradients, no invented series. Every chart
states its window in the caption.

## 14. Navigation

Dark rail (`night`), 13px items, 32px rows, active state = white/12 background
plus brand-200 icon. Role-aware items, but authorisation is enforced in the
server action — never by the missing link. Mobile: horizontally scrollable
pill row, same order, same labels.

## 15. Responsive

Breakpoints follow Tailwind defaults: `sm 640`, `md 768`, `lg 1024`, `xl 1280`.
Two-column detail layouts collapse to one at `xl`; tables gain horizontal scroll
inside a bounded container rather than shrinking text; no page-level horizontal
overflow at 360px.

## 16. Accessibility

- Semantic landmarks, one `h1` per page, real `<table>` markup.
- Every control reachable and operable by keyboard; focus is always visible.
- Contrast ≥ 4.5:1 for body text, ≥ 3:1 for large text and UI borders.
- Status conveyed by text (`Blocked by calibration`), not colour alone.
- `aria-live="polite"` on flash messages; form errors linked with `aria-describedby`.
- `prefers-reduced-motion` disables transitions; no motion carries meaning.
- Icon-only controls always have an accessible name.

## 17. Motion

150ms ease-out on hover/press, 200ms on panels. Nothing animates on load, no
parallax, no spring physics. Reduced motion removes transitions entirely.

## 18. Copy rules

1. Specific over generic: name the asset, the date, the number.
2. Errors state cause + fix in one or two sentences.
3. Empty states offer the next action.
4. No exclamation marks, no "Oops", no emoji.
5. Sample: *"Calibration expired on 12 Oct 2026. Bookings are blocked until a
   valid calibration is recorded."*

## 19. Component inventory (implemented)

`Badge`, `BookingBadge`, `ResourceBadge`, `SeverityBadge`, `PageHeader`, `Stat`,
`EmptyState`, `Flash`, `SectionHeading`, `Meter`, `InlineLink`, `ReadinessPanel`,
`AppShell`, `AppNav`/`MobileNav`, `SubmitButton`, `Icon`, `Logo`.

## 20. Debt / not yet done

- No dark mode (documented above).
- No i18n layer; strings are English-only and no translation is claimed.
- Charts are CSS meters, not a chart library; acceptable at current density.
