# 04 — UI/UX & Accessibility Guidelines

Reference device: **360 × 640 CSS px, 2 GB RAM, Android Go, Chrome, 2G**. Every screen below is
specified at that width first; tablet and desktop are progressive enhancements, never the source
of truth.

---

## 1. Design principles

1. **Offline is a state, not an error.** No screen shows a network failure page. The worst state
   is "cached data + queued-changes chip", and it is fully usable.
2. **One primary action per screen.** A teacher opening the app at 07:10 has exactly one job.
3. **Time order beats every other order.** Teachers and students think in periods. Never re-sort
   a day by status, priority or recency.
4. **Bangla first, English equal.** Not a translation layer bolted on — Bangla is the design
   language, and every layout is tested with Bangla strings, which run 15–30 % longer than English.
5. **Every byte is a decision.** No icon font, no illustration library, no client-side charting on
   the critical path. SVG sprites, system-adjacent fonts, server-rendered summaries.
6. **Show the mechanism.** When the system decides something — a substitute, a suppressed SMS, a
   conflict — say why in one plain sentence. Opaque automation loses trust fast in this market.

---

## 2. Typography — Bangla and English together

### 2.1 Type stack

```css
:root {
  --font-bn: 'Noto Sans Bengali', 'Hind Siliguri', 'SolaimanLipi', 'Kalpurush', sans-serif;
  --font-en: 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  --font-num: var(--font-en);       /* Latin digits by default; see §2.4 */
}
html[lang="bn"] body { font-family: var(--font-bn); }
html[lang="en"] body { font-family: var(--font-en); }
```

Fonts are self-hosted, subset and preloaded. Budget: **≤ 42 KB total**.

```
Noto Sans Bengali  — subset U+0980–09FF, U+200C–200D (ZWNJ/ZWJ), U+0964–0965  → 28 KB WOFF2
Inter              — subset U+0000–00FF, U+2000–206F                          → 14 KB WOFF2
```

```html
<link rel="preload" as="font" type="font/woff2" crossorigin
      href="/fonts/noto-bengali-subset.woff2">
<style>
  @font-face {
    font-family: 'Noto Sans Bengali';
    src: url('/fonts/noto-bengali-subset.woff2') format('woff2');
    unicode-range: U+0980-09FF, U+200C-200D, U+0964-0965;
    font-display: swap;            /* never block first paint on a font */
    size-adjust: 100%;
  }
</style>
```

**ZWNJ and ZWJ (U+200C/U+200D) must be in the subset.** They are what make Bangla conjuncts
(যুক্তাক্ষর) render correctly — drop them and `ক্ষ` breaks into `ক্‌ষ` on some renderers.

### 2.2 Bangla-specific rules

Bangla has a headline stroke (মাত্রা) plus ascenders, descenders and stacked conjuncts. Latin
type metrics do not transfer.

| Rule | Value | Why |
|---|---|---|
| Minimum body size | **16 px** (never 14) | Conjuncts like ক্ষ্ম become unreadable below ~15 px on 1× DPI screens |
| Line height | **1.75** body, **1.55** headings (vs 1.5 / 1.2 for Latin) | Descenders of one line collide with the মাত্রা of the next |
| `letter-spacing` | **`normal` — never adjust** | Positive tracking visually severs conjuncts; negative destroys them |
| `text-transform` | **never** | Bangla has no case; `uppercase` is a no-op that breaks mixed strings |
| `font-weight` | 400 / 600 only | Most free Bangla faces have no real 500 or 700; the browser synthesises and it smears |
| Numerals | Latin by default, Bangla opt-in | See §2.4 |
| Justification | **never** `text-align: justify` | Bangla word-spacing gaps become rivers |
| Hyphenation | off | No reliable Bangla hyphenation dictionary in browsers |
| Truncation | by word, never `text-overflow: ellipsis` mid-conjunct | A clipped conjunct renders as a different, wrong letter |

### 2.3 Type scale

| Token | Size / line-height | Use |
|---|---|---|
| `--t-display` | 28 / 1.4 | Numbers on dashboards only |
| `--t-h1` | 22 / 1.55 | Screen title |
| `--t-h2` | 19 / 1.6 | Card title, section header |
| `--t-body` | 16 / 1.75 | Everything |
| `--t-small` | 14 / 1.7 | Metadata, timestamps — **Latin only**, never Bangla prose |
| `--t-micro` | 12 / 1.6 | Latin badges and codes only |

`--t-small` and `--t-micro` are explicitly forbidden for Bangla sentences. If a Bangla string
does not fit at 16 px, the layout is wrong, not the type size.

### 2.4 Numerals

Bangla digits (০১২৩৪৫৬৭৮৯) read naturally in prose but are error-prone in dense tables — many
users enter Latin digits on a Bangla keyboard. Policy:

- **Prose, dates, period numbers, counts** → locale-appropriate (`Intl.NumberFormat('bn-BD')`).
- **Money, roll numbers, marks, phone numbers, IDs** → **always Latin**, `font-variant-numeric: tabular-nums`.
- **Inputs** → accept both, normalise to Latin on blur, echo back in the user's locale.

```ts
const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
export const toLatinDigits = (s: string) =>
  s.replace(/[০-৯]/g, d => String(BN_DIGITS.indexOf(d)));
```

This one function prevents a whole class of "the marks didn't save" bugs.

---

## 3. Design tokens

```css
:root {
  /* Colour — WCAG AA against #FFFFFF at ≥4.5:1 for all text tokens */
  --c-primary:      #006A4E;   /* Bangladesh green, 5.9:1 on white */
  --c-primary-ink:  #004D38;
  --c-accent:       #F42A41;   /* used sparingly: destructive + the "now" pulse */
  --c-warn:         #B45309;   /* substitution amber, 4.6:1 */
  --c-success:      #15803D;
  --c-ink:          #111827;   /* 16.1:1 */
  --c-ink-2:        #4B5563;   /* 7.6:1 — the lightest text allowed */
  --c-line:         #E5E7EB;
  --c-surface:      #FFFFFF;
  --c-surface-2:    #F9FAFB;

  /* Space — 4 px base */
  --s-1: 4px;  --s-2: 8px;  --s-3: 12px; --s-4: 16px;
  --s-5: 24px; --s-6: 32px; --s-7: 48px;

  /* Touch */
  --tap-min: 48px;             /* WCAG 2.2 AAA target size; also just correct for a shared phone */
  --tap-gap: 8px;

  --radius: 10px;
  --shadow-1: 0 1px 2px rgba(0,0,0,.06);   /* one shadow level. GPU compositing is expensive on Go devices */
}
```

**Colour is never the only signal.** Every status carries an icon or text label alongside its
colour — roughly 8 % of male students have a colour-vision deficiency, and the amber
substitution card must be distinguishable from the green "held" card without hue.

---

## 4. Screen specifications

### 4.1 Attendance grid — the 30-second screen

The single most-used screen in the product. Target: a 60-student section marked in **under 30 s**
with zero network.

```
┌────────────────────────────────────────────┐
│ ←  হাজিরা · ৯-ক          ৩য় পিরিয়ড  ⚡     │  56px
│    পদার্থবিজ্ঞান · ০৬ আগস্ট                  │
├────────────────────────────────────────────┤
│  উপস্থিত ৩৮   অনুপস্থিত ৩   দেরি ১          │  40px  live counters
│  [সবাই উপস্থিত]                             │  ← default-all-present, then mark exceptions
├────────────────────────────────────────────┤
│ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐          │
│ │ ০১ │ │ ০২ │ │ ০৩ │ │ ০৪ │ │ ০৫ │          │  56×56 tiles, 5 per row at 360px
│ │ ✓  │ │ ✓  │ │ ✗  │ │ ✓  │ │ ⏱ │          │  tap = cycle ✓ → ✗ → ⏱ → ✓
│ └────┘ └────┘ └────┘ └────┘ └────┘          │
│ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐          │
│ │ ০৬ │ │ ০৭ │ │ ০৮ │ │ ০৯ │ │ ১০ │          │
│ │ ✓  │ │ ✓  │ │ ✓  │ │ ✓  │ │ ✓  │          │
│ └────┘ └────┘ └────┘ └────┘ └────┘          │
│              … 60 tiles total …              │
├────────────────────────────────────────────┤
│  [  সংরক্ষণ করুন  ]                          │  56px sticky, always reachable
└────────────────────────────────────────────┘
```

**Why this shape:**

- **Roll numbers, not names.** Teachers call the roll; names are 3× wider in Bangla and would cut
  the grid to 2 columns and 30 rows of scrolling. Long-press a tile shows the name + photo.
- **Default all present.** In a typical section 3–5 students are absent. Marking exceptions is
  ~6 taps; marking every student is 60. The `[সবাই উপস্থিত]` button is pre-applied on open.
- **Tap-to-cycle, not a picker.** No modal, no dropdown, no scroll-away. One tap per state change.
- **Counters update live** so the teacher can cross-check against a headcount before saving.
- **Save writes to IndexedDB only.** Perceived latency ~60 ms. The ⚡ chip carries the sync state.
- **Undo, not confirm.** Save is instant with a 5-second "ফিরিয়ে নিন" snackbar. A confirmation
  dialog on a 30-second task is a 20 % time tax.

Accessibility: each tile is a `<button role="checkbox" aria-checked>` with
`aria-label="রোল ৩, রহিম উদ্দিন, অনুপস্থিত"`. The grid is arrow-key navigable on tablets with
keyboards.

### 4.2 Teacher daily schedule

Fully specified in [02-RMS-DEEP-DIVE.md §6](02-RMS-DEEP-DIVE.md). Summary of the contract: the
"now" card auto-scrolls into view, every action works offline, attendance is one tap away,
substitution cards are amber and sort in time order.

### 4.3 Guardian dashboard

Guardians are the least technical audience, often on a shared handset, frequently with limited
literacy. This screen is written to be understood in five seconds.

```
┌────────────────────────────────────────────┐
│  আমার সন্তান                          👤   │
├────────────────────────────────────────────┤
│ ┌────────────────────────────────────────┐ │
│ │ 👦 রহিম উদ্দিন                          │ │
│ │    ৯ম শ্রেণি — ক শাখা · রোল ১২          │ │
│ │ ─────────────────────────────────────  │ │
│ │  আজ         ✓ উপস্থিত                  │ │  ← the single most-asked question
│ │  এ মাসে     ৯২% উপস্থিতি                │ │
│ │  বকেয়া ফি   ৳ ১,২৫০   [পরিশোধ করুন]    │ │  ← the single most-valuable action
│ └────────────────────────────────────────┘ │
│                                             │
│  সাম্প্রতিক                                  │
│  • ফলাফল প্রকাশিত — অর্ধবার্ষিক  GPA ৪.৮৩   │
│  • ০৪ আগস্ট অনুপস্থিত ছিল                   │
│  • আগামীকাল পদার্থবিজ্ঞান পরীক্ষা            │
│                                             │
│  [ একাধিক সন্তান? ⌄ ]                       │  ← sibling switcher, collapsed by default
└────────────────────────────────────────────┘
```

- Attendance and fee balance are above the fold, always. Everything else is a feed.
- The pay button deep-links straight into the bKash/Nagad flow with the amount pre-filled.
- No charts. A percentage and a colour communicate more than a sparkline at this literacy level
  and cost 40 KB less.

### 4.4 Student — ShikhoAI tutor

```
┌────────────────────────────────────────────┐
│ ← শিখো AI          পদার্থবিজ্ঞান · অধ্যায় ৫  │  ← scope is always visible and always bounded
├────────────────────────────────────────────┤
│                                             │
│  ┌──────────────────────────────────────┐  │
│  │ নিউটনের ২য় সূত্র বুঝি না             │  │  right-aligned, user
│  └──────────────────────────────────────┘  │
│                                             │
│  ┌──────────────────────────────────────┐  │
│  │ আচ্ছা, একটা প্রশ্ন দিয়ে শুরু করি —     │  │  left-aligned, tutor
│  │ তুমি যদি একটা ফুটবলে আর একটা          │  │  Socratic: asks before it tells
│  │ ক্রিকেট বলে একই জোরে লাথি দাও,        │  │
│  │ কোনটা বেশি দূরে যাবে? কেন?            │  │
│  │                    📖 পাঠ্যবই পৃ. ৭২   │  │  ← every answer cites the NCTB source
│  └──────────────────────────────────────┘  │
│                                             │
├────────────────────────────────────────────┤
│ [বাংলা][English][Banglish]   💬 লিখুন…  ➤   │
└────────────────────────────────────────────┘
```

- **Scope chip is permanent.** The student always sees which chapter the tutor is bounded to,
  which is also the guardrail: out-of-syllabus questions get a redirect, not an answer.
- **Citations are mandatory.** Every substantive response shows the textbook page. This is what
  makes teachers tolerate the tutor existing.
- **Banglish is a first-class input mode**, not an accident — most students type romanised Bangla.
- **Offline** shows the cached-explanation pack with an explicit "অফলাইন — সংরক্ষিত ব্যাখ্যা"
  label. Never a fabricated live answer.

### 4.5 Principal dashboard (tablet/desktop, 1024 px+)

Four tiles above the fold, each answering one question a principal actually asks daily:

| Tile | Question | Source |
|---|---|---|
| Attendance today | "Who's missing, students and staff?" | `mv_attendance_daily` |
| Classes covered | "Did every scheduled period actually happen?" | `mv_syllabus_progress` + `class_delivery_log` |
| Fees this month | "How much came in, how much is outstanding?" | `mv_fee_collection` |
| Needs attention | Uncovered periods, unapproved corrections, safeguarding flags, failed SMS | union query |

Server-rendered as HTML with inline SVG sparklines. No dashboard framework, no client charting
library — the whole page is under 60 KB.

---

## 5. Accessibility

Target: **WCAG 2.2 Level AA**, with AAA target-size (44 × 44 minimum, 48 × 48 in practice).

| Area | Commitment |
|---|---|
| Contrast | All text ≥ 4.5:1; large text ≥ 3:1; UI boundaries ≥ 3:1. `--c-ink-2` (#4B5563) is the lightest text token permitted |
| Target size | 48 × 48 px minimum, 8 px gap. Attendance tiles are 56 × 56 |
| Focus | Visible 2 px `--c-primary` outline with 2 px offset on every interactive element; never `outline: none` |
| Keyboard | Full operability including the routine drag-drop editor (arrow keys move a slot, Enter drops, Esc cancels) |
| Screen reader | Semantic HTML first. `aria-live="polite"` on sync status and attendance counters; `aria-live="assertive"` only for errors |
| Language | `lang="bn"` / `lang="en"` on the root **and** on any mixed-language span — otherwise screen readers pronounce Bangla with English phonemes |
| Motion | Everything behind `prefers-reduced-motion`; the "now" card pulse is the only ambient animation and it stops when reduced motion is set |
| Zoom | Layout survives 200 % zoom and 320 px width with no horizontal scroll |
| Forms | Every input has a visible `<label>`; errors are text + icon, never colour alone; `inputmode="numeric"` on roll/marks/amount fields |
| Timeouts | No session timeout inside an in-progress attendance or mark-entry flow |

**Bangla screen-reader reality check.** TalkBack's Bangla TTS is materially worse than its English.
Consequences we design around: keep Bangla `aria-label`s short and use everyday words; never rely
on a screen reader to disambiguate two similar Bangla strings; give every icon-only control a text
alternative that is also displayed visually on first use.

---

## 6. Low-bandwidth asset policy

| Asset | Rule |
|---|---|
| Icons | One inline SVG sprite, ≤ 6 KB, no icon font |
| Photos (student/staff) | 96 px avatar WebP, ≤ 4 KB, lazy, `content-visibility: auto`; initials-on-colour placeholder is the default and photos are opt-in |
| Illustrations | None. Empty states are one line of text plus one sprite icon |
| Charts | Server-rendered inline SVG. No charting library ships to the client |
| Fonts | 2 files, ≤ 42 KB total, subset, preloaded, `font-display: swap` |
| JS | ≤ 180 KB gz on the critical path, enforced by a CI bundle gate that fails the build |
| Images in content | `loading="lazy"`, explicit `width`/`height` to prevent CLS, Cloudflare on-the-fly resize by DPR |
| Third-party | **Zero** on the critical path. Analytics is a 1.4 KB first-party beacon that batches and flushes on `visibilitychange` |

### Data-saver behaviour

```ts
const conn = (navigator as any).connection;
const lite = conn?.saveData || ['slow-2g','2g'].includes(conn?.effectiveType);
```

When `lite` is true: skip avatar loading entirely, disable the answer-script auto-crop WASM,
raise the sync batch interval from 30 s to 5 min, and drop image quality to q=0.45. The user sees
a "ডেটা সাশ্রয় মোড" chip and can override it.

---

## 7. Localisation

- **Locale keys, never concatenation.** Bangla word order differs; `"Class " + n + " Section " + s`
  produces nonsense. Use ICU MessageFormat: `"{class} শ্রেণি — {section} শাখা"`.
- **Pluralisation:** Bangla has no plural agreement on nouns after a numeral, so `other` alone is
  correct — but the ICU category must still be declared so a future Urdu/Arabic locale for Madrasah
  content does not break.
- **Dates:** Bengali month names (বৈশাখ…) are used for cultural dates only. Academic dates use the
  Gregorian calendar with Bangla month names (জানুয়ারি, ফেব্রুয়ারি…), which is what school
  notices actually use.
- **Layout testing:** every string is tested at **+35 % length**. Bangla labels routinely exceed
  their English equivalents; a button sized to "Save" will clip "সংরক্ষণ করুন".
- **RTL:** not required today. Madrasah Arabic content is display-only text, rendered inside an
  `dir="rtl"` span rather than flipping the app chrome.

---

## 8. Component inventory (build order)

| Component | Notes |
|---|---|
| `AppShell` | Header + bottom nav + offline chip + `aria-live` region |
| `SyncChip` | Queued-op count, last-sync time, tap → sync detail sheet |
| `PeriodCard` | Three variants: now / upcoming / non-teaching; substitution modifier |
| `AttendanceGrid` | Virtualised above 80 tiles; tap-cycle; long-press detail |
| `RosterSheet` | Bottom sheet, roll + name + photo, search with Bangla trigram matching |
| `MarkEntryTable` | Sticky roll column, `inputmode="decimal"`, per-component CQ/MCQ columns, live pass/fail flag |
| `RoutineGrid` | Desktop drag-drop with live clash shading; mobile read-only week view with day snap |
| `SubstitutionQueue` | Ranked candidates with justification strings |
| `FeeCard` | Balance, due date, one-tap MFS deep link |
| `AIChat` | SSE streaming, scope chip, citation pills, offline mode |
| `EmptyState` | One line + one icon. No illustrations, ever |
| `ConflictDiff` | Two-column bn/en diff with a single keep-mine / take-server choice |
