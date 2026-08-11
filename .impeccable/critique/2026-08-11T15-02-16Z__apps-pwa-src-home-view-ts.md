---
target: "Home dashboard (#/home)"
total_score: 28
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
timestamp: 2026-08-11T15-02-16Z
slug: apps-pwa-src-home-view-ts
---
# Critique — Home dashboard (Operate) — Shikhon PWA

Method: dual-agent (A: design review · B: detector full-fidelity). Detector clean ([], exit 0) on index.html, app.css, offline.html.

## Design Health Score: 28/40 (Good)
1 Visibility of system status: 2 — offline-first app, no sync/offline state on Home; sync-chip/offline-banner exist in CSS, never mounted.
2 Match real world: 4 — Bangla-primary, Bangla digits/date, time-aware greeting, informal তোমার for students vs formal staff.
3 User control & freedom: 3 — read-only launcher; logout present.
4 Consistency & standards: 3 — strong tokens; two card affordances differ (chevron on .home-card, none on .next-card).
5 Error prevention: 4 — role-gating hides actions that would 403.
6 Recognition over recall: 3 — glyph+label+sub everywhere; glyph set mixed-metaphor with duplicates.
7 Flexibility & efficiency: 3 — next block accelerates students; no shortcut for teacher hunting 1 of 14.
8 Aesthetic & minimalist: 3 — student Home calm; teacher Home a 14-choice wall.
9 Error recovery: 1 — loadNext().catch(()=>{}) silent; empty vs failed identical; no retry, on slow-3G users.
10 Help & documentation: 2 — no first-run orientation; guardian gets nothing.

## Design specificity: authored at top (role-intent dashboards, next block with why, accent restraint), generic in lower half (teacher secondary grid = 12 undifferentiated tiles duplicating ~80% of More).

## Priority issues
[P1] next block loads/fails invisibly — no skeleton, empty==error, catch swallows failure. harden.
[P1] Teacher Home 14-choice wall duplicating More — breaks Miller, defeats progressive disclosure. distill.
[P2] No sync/offline affordance on Home. harden.
[P2] Late next insertion shifts grid (CLS) — mis-tap on 3G. optimize.
[P3] Mixed-metaphor glyphs with duplicates; emoji break monochrome on Android Go. polish.

## Persona red flags
Jordan (guardian): guardian's own আমার সন্তান summary not on guardian dashboard, only in More.
Sam (low vision): .section-heading --c-ink-3 (#7d7979) 13px ≈ 3.9:1 below AA; .next-slot no aria-live.
Latent: .section-heading letter-spacing 0.02em with no :not([lang=bn]) guard — Override 2 violation on Bangla conjuncts.
