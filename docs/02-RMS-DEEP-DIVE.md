# 02 — Routine Management System (RMS) Deep-Dive

The RMS is the module that decides whether the whole product gets used daily. Attendance is a
30-second task; the routine is the thing a teacher opens the moment they wake up.

---

## 1. Domain model

```
academic_year
   └── term
        └── routine  (one active version per class-section-set, versioned & published)
             └── routine_slot   ← the atomic unit: WHO teaches WHAT to WHICH section WHERE WHEN
                  ├── teacher (users)
                  ├── subject
                  ├── section (class + section, e.g. "Class 9 — Science — A")
                  ├── room    (nullable: assembly, games, and Madrasah ছুটি periods have no room)
                  └── period  (day_of_week × period_no → concrete time band)

routine_substitution   ← an override for ONE date, pointing at ONE routine_slot
teacher_availability   ← recurring unavailability (part-time, admin duty) + dated leave
teacher_subject_expertise ← (teacher, subject, class_level, proficiency) — drives substitution ranking
period_template        ← per-shift bell schedule; a school may run Morning + Day shifts
```

**Bangladeshi realities the model must absorb, and does:**

- **Multi-shift schools.** Morning shift (07:30–12:00, often girls) and Day shift (12:30–17:00).
  Modelled as `shift` on `section` and `period_template`; a teacher may serve both, and the
  clash detector treats the day as one continuous timeline so cross-shift double-booking is caught.
- **Friday/Saturday weekend**, with Madrasah institutions frequently on **Friday-only**. `weekend_days`
  is a per-tenant `smallint[]`.
- **Ramadan / short schedule.** A `period_template` is date-effective, so a school swaps to a
  40-minute-period Ramadan template without rebuilding routines.
- **Madrasah dual curriculum** — general subjects plus আরবি/কুরআন/হাদিস — modelled as ordinary
  subjects with `stream = 'madrasah'`; no special-casing in the engine.
- **Combined/split sections.** Class 9–10 Science practicals often merge two sections into one lab.
  A `routine_slot` may carry multiple sections via `routine_slot_sections` (many-to-many).
- **Assembly, tiffin, games** occupy periods and must block teacher availability; they are slots
  with `slot_kind = 'non_teaching'`.

---

## 2. Functional workflows

### 2.1 Routine generation

```
[Academic Coordinator]
  1. Select academic year + term + shift + effective-from date
  2. Confirm inputs:
       • period_template (bell schedule)          ← pre-filled from last term
       • sections in scope                        ← Class 6A … Class 10C
       • subject-period requirements per section  ← "Class 9 Physics: 5 periods/wk, 2 must be double"
       • teacher supply + max load                ← "Rahim Sir: max 26 periods/wk, unavailable Sun p1-p2"
       • room inventory + capabilities            ← "Lab-1: physics, capacity 40"
  3. ▶ Generate  →  rms-svc runs the solver (§3)
  4. Review DRAFT: three tabs — by Section | by Teacher | by Room
       • Every violated soft constraint is listed with a "why" and a one-tap fix suggestion
       • Hard-constraint violations cannot exist (the solver is infeasible-or-valid)
  5. Manual adjustments via drag-drop; each drop is validated in <50 ms against the clash API
  6. ▶ Publish  →  version++, becomes ACTIVE at effective_from, emits routine.published.v1
       • previous version is retained; a diff view shows exactly what changed
       • affected teachers + guardians get a notification; PWA clients invalidate their cursor
```

**Infeasibility is a first-class outcome.** If no valid routine exists, the solver returns the
minimal conflicting subset — "Class 9 and Class 10 both need Lab-1 for 6 periods, but Lab-1 only
has 5 free" — rather than a generic failure. This is what makes the feature usable by a
coordinator who is not an operations researcher.

### 2.2 Teacher daily tracking

A teacher's day is a *derived* read: `routine_slots` for today's weekday, left-joined with
`routine_substitutions` for today's date, ordered by period. Materialised into a per-teacher
`teacher_day_view` and pushed to IndexedDB during the nightly sync so it renders offline at 07:00.

Per-slot the teacher can, entirely offline:
- Mark **class held / not held** (with reason) — feeds the coverage report.
- Jump straight into **attendance** for that section (one tap, pre-scoped).
- Open the **lesson plan** attached to that slot (SikhokAI-generated or manual).
- Log a **syllabus-progress** entry: chapter/topic covered → drives the "syllabus completion %"
  the Principal watches.

### 2.3 Absence → substitution

```
Trigger (any of):
   • Teacher taps "I'm on leave" (with date range) in the PWA
   • Coordinator marks leave in admin
   • Teacher fails to mark "class held" 10 min into a period  → soft signal, prompts coordinator
        │
        ▼
rms-svc: find_affected_slots(teacher, date_range)
        │
        ▼
For each affected slot → substitution candidate search (§5)
        │
        ▼
Coordinator sees a single screen: "6 periods need cover"
   each row: slot · ranked candidates with a score + one-line justification
   [Auto-assign all]  or per-row [Assign] / [Cancel class] / [Merge with section B]
        │
        ▼
Assignment writes routine_substitutions, emits routine.substitution_assigned.v1
        │
        ├─► SMS + push to the substitute teacher
        ├─► Push to the affected section's students/guardians
        └─► Substitute's teacher_day_view updated; syncs to their device
```

Two escape hatches beyond "assign a teacher": **cancel** (students get a free/self-study period,
guardians notified) and **merge** (two sections combined into one room for that period — the
model supports it via `routine_slot_sections`, and the room-capacity check runs on the sum).

---

## 3. Routine generation algorithm

Timetabling is NP-hard; the practical answer is a constraint solver with a good model, not a
hand-rolled greedy heuristic.

**Engine:** Google **OR-Tools CP-SAT**, invoked from `rms-svc` (Go) via the C++ library through
cgo, or as a sidecar gRPC service. Typical school (40 teachers, 24 sections, 8 periods × 6 days
= ~1 150 slots): **solves in 4–25 s**. Cap at 60 s and return the best-known feasible solution.

### 3.1 Decision variables

For every (section `s`, subject `j`, period-instance `p`) a boolean `x[s,j,p]`, plus a teacher
assignment `t[s,j] ∈ eligible_teachers(j, class_level(s))` and a room `r[s,j,p]`.
Reduced up front by pre-filtering impossible combinations (teacher not qualified, room lacks
capability, section not in shift).

### 3.2 Hard constraints (must hold — solver rejects otherwise)

| # | Constraint |
|---|---|
| H1 | A teacher occupies at most one slot per period-instance (across **all** shifts) |
| H2 | A section occupies at most one slot per period-instance |
| H3 | A room hosts at most one slot per period-instance |
| H4 | Each (section, subject) gets exactly its required weekly period count |
| H5 | Only qualified teachers are assigned (`teacher_subject_expertise` exists) |
| H6 | Teacher unavailability windows are respected (`teacher_availability`) |
| H7 | Room capability ⊇ subject requirement (lab, computer, prayer hall) and capacity ≥ section size |
| H8 | Teacher weekly load ≤ `max_periods_per_week`; daily load ≤ `max_periods_per_day` |
| H9 | Double periods (practicals) occupy consecutive periods with no tiffin break between |
| H10 | Fixed slots (assembly p0, Friday Jumu'ah block, tiffin) are pre-pinned and immovable |

### 3.3 Soft constraints (weighted objective, minimised)

| Weight | Goal |
|---|---|
| 100 | No teacher gap ("free period sandwiched between two classes") — teachers hate these most |
| 80 | Core subjects (Bangla, English, Maths) placed in periods 1–4 |
| 70 | Even spread: the same subject not twice in one day for a section unless it's a double |
| 60 | Teacher daily load balanced (minimise variance) |
| 50 | Minimise teacher room-hopping between consecutive periods (building-distance aware) |
| 40 | Respect teacher preferred-period hints |
| 30 | Games/arts placed in the last period |
| 20 | Same subject at a consistent time-of-day across the week for a section |

Weights are **tenant-configurable** — a Madrasah may push prayer-adjacency higher, an English-version
school may weight lab continuity higher.

### 3.4 Incremental re-solve

After publication, a coordinator moving one slot must not trigger a 25-second global re-solve.
`POST /rms/routines/{id}/moves` runs a **local repair**: fix every variable except the moved slot
and its transitive conflicts (typically 3–15 slots), re-solve that neighbourhood in **< 300 ms**.

---

## 4. Clash detection

Two layers, because the UI needs speed and the database needs truth.

### 4.1 Layer 1 — database-enforced (the guarantee)

`btree_gist` exclusion constraints make double-booking **structurally impossible**, regardless of
which service, script or human wrote the row:

```sql
-- Excerpt from db/migrations/006_routines_rms.sql
ALTER TABLE routine_slots
  ADD CONSTRAINT rs_no_teacher_double_booking
  EXCLUDE USING gist (
    tenant_id        WITH =,
    teacher_id       WITH =,
    day_of_week      WITH =,
    time_range       WITH &&        -- tstzrange/timerange overlap operator
  )
  WHERE (status = 'active' AND slot_kind <> 'free');

ALTER TABLE routine_slots
  ADD CONSTRAINT rs_no_room_double_booking
  EXCLUDE USING gist (
    tenant_id WITH =, room_id WITH =, day_of_week WITH =, time_range WITH &&
  )
  WHERE (status = 'active' AND room_id IS NOT NULL);

ALTER TABLE routine_slots
  ADD CONSTRAINT rs_no_section_double_booking
  EXCLUDE USING gist (
    tenant_id WITH =, primary_section_id WITH =, day_of_week WITH =, time_range WITH &&
  )
  WHERE (status = 'active');
```

Using a `timerange` (not `period_no`) is deliberate: it correctly catches cross-shift overlaps and
period templates whose bells don't line up between shifts, which an integer period number cannot.

A violation surfaces as SQLSTATE `23P01` (`exclusion_violation`), which the service maps to a
structured 409 naming the conflicting slot.

### 4.2 Layer 2 — in-memory (the speed)

The drag-drop editor cannot round-trip to Postgres on every hover. `rms-svc` keeps a per-routine
**bitset occupancy index** in Redis:

```
key: t:{tenant}:rt:{routineId}:occ:teacher:{teacherId}   → 384-bit bitmap (6 days × 64 minutes-slots)
key: t:{tenant}:rt:{routineId}:occ:room:{roomId}         → same shape
key: t:{tenant}:rt:{routineId}:occ:section:{sectionId}   → same shape
```

A candidate placement is a bitwise AND against three bitmaps — **O(1), ~20 µs**. The editor
validates every drag target in real time and greys out illegal drop zones before the user releases.
Redis is a cache of derived state; the DB constraint remains the authority.

### 4.3 Clash API

```http
POST /api/v1/rms/routines/{routineId}/validate-placement
{
  "slotId": "rsl_018f…",           // null when creating
  "teacherId": "usr_9812",
  "roomId": "rm_lab1",
  "sectionIds": ["sec_9a"],
  "dayOfWeek": 0,                   // 0=Sunday (BD week starts Sunday)
  "periodNo": 3
}
→ 200
{
  "ok": false,
  "conflicts": [
    {
      "type": "teacher_busy",
      "severity": "hard",
      "message": "রহিম স্যার এই সময়ে ৯-খ শ্রেণিতে পদার্থবিজ্ঞান পড়াচ্ছেন",
      "messageEn": "Rahim Sir teaches Physics to Class 9-B at this time",
      "conflictingSlotId": "rsl_018e…"
    }
  ],
  "warnings": [
    { "type": "teacher_gap_created", "severity": "soft",
      "message": "রহিম স্যারের ২য় ও ৪র্থ পিরিয়ডের মাঝে ফাঁকা তৈরি হবে" }
  ]
}
```

---

## 5. Substitution engine

Finding cover is a ranked search, not an optimisation problem — the coordinator wants a
justified shortlist in under a second.

### 5.1 Candidate filter (hard)

A teacher is a candidate only if **all** hold for that date and period:

1. Free — no active slot and no substitution already assigned for that period.
2. Not on leave, not otherwise unavailable (`teacher_availability`).
3. Under their daily cap **including** substitutions already assigned today.
4. Not already assigned the maximum substitutions this week (`max_substitutions_per_week`, default 4 —
   protects the reliable teacher from being the sink for everyone else's absence).
5. Physically reachable: not required in a distant building in the adjacent period.

### 5.2 Ranking score

```
score = 40·expertise      // 1.0 exact subject+class expertise; 0.7 subject, adjacent class;
                          // 0.4 same department; 0.15 general cover only
      + 20·familiarity    // already teaches this section another subject → students behave better
      + 15·continuity     // has taught this subject to this section as a substitute before
      + 10·load_headroom  // (cap − assigned_today) / cap
      +  8·adjacency      // free in the period immediately before/after → no room-hopping
      +  7·fairness       // inverse of substitutions taken over the last 30 days
      −  25·(is_teaching_own_class_next_period ? 1 : 0)     // avoid back-to-back-to-back
      −  15·(would_create_5_consecutive_periods ? 1 : 0)
```

Each returned candidate carries a **human justification string** in Bangla and English —
"একই বিষয়ে বিশেষজ্ঞ, এই সেকশনে পড়ান, ৩য় পিরিয়ড ফাঁকা" — so the coordinator is never asked to
trust an opaque number.

### 5.3 Auto-assign policy

Auto-assign fires only when the top candidate scores ≥ 60 **and** leads the runner-up by ≥ 10;
otherwise the coordinator chooses. Auto-assignments are labelled as such and are reversible for
24 hours.

If **no** candidate exists, the engine returns escalating fallbacks in order:
merge with a parallel section → assign a supervised self-study slot with materials from the
subject teacher's lesson plan → cancel and notify guardians.

### 5.4 API

```http
GET /api/v1/rms/substitutions/candidates?slotId=rsl_018f…&date=2026-08-09
→ 200
{
  "slot": { "subject": "পদার্থবিজ্ঞান", "section": "৯-ক", "period": 3, "room": "Lab-1" },
  "candidates": [
    { "teacherId": "usr_4471", "name": "সালমা আক্তার", "score": 82.4,
      "reasons": ["exact_subject_expertise", "teaches_this_section", "period_2_free"],
      "justificationBn": "একই বিষয়ে বিশেষজ্ঞ · এই সেকশনে পড়ান · আগের পিরিয়ড ফাঁকা",
      "loadToday": 3, "loadCap": 6, "substitutionsThisWeek": 1 },
    { "teacherId": "usr_5590", "name": "কামরুল হাসান", "score": 61.0, "…": "…" }
  ],
  "autoAssignRecommended": "usr_4471",
  "fallbacks": [ { "type": "merge_with_section", "targetSectionId": "sec_9b", "feasible": true } ]
}
```

---

## 6. Teacher daily-schedule dashboard — UI/UX specification

**Primary surface. Mobile-first, 360 × 640 CSS px reference viewport. This is what a teacher sees
at 07:10 on a 2 GB phone with no signal.**

### 6.1 Layout

```
┌────────────────────────────────────────────┐ 360px
│ ☰  আজকের রুটিন            ৬ আগস্ট  ⚡অফলাইন │  56px  sticky header
│    Rahim Uddin · Physics                    │        (⚡ chip = offline/queued state)
├────────────────────────────────────────────┤
│ [আজ]  [সপ্তাহ]  [বদলি ২]                    │  44px  segmented control
├────────────────────────────────────────────┤
│  ▸ NOW  ────────────────────────────────    │
│ ┌────────────────────────────────────────┐ │
│ │ ৳ 3rd  10:20–11:00         ● চলছে      │ │  ← "now" card is 1.4× tall,
│ │ পদার্থবিজ্ঞান                            │ │     accent left border 4px,
│ │ ৯-ক  ·  কক্ষ ২০৪  ·  ৪২ জন              │ │     subtle pulse on the dot
│ │ ┌──────────────┐ ┌──────────────────┐  │ │
│ │ │ হাজিরা নিন   │ │ পাঠ পরিকল্পনা     │  │ │  48px tap targets
│ │ └──────────────┘ └──────────────────┘  │ │
│ └────────────────────────────────────────┘ │
│                                             │
│ ┌────────────────────────────────────────┐ │
│ │ 4th  11:00–11:40        ✓ হাজিরা হয়েছে │ │  72px  compact card
│ │ গণিত · ৮-খ · কক্ষ ১০১                   │ │
│ └────────────────────────────────────────┘ │
│ ┌────────────────────────────────────────┐ │
│ │ 5th  11:40–12:20     ⓘ বদলি ক্লাস       │ │  ← substitution: amber left border
│ │ রসায়ন · ১০-ক · ল্যাব-১                  │ │     + "for Salma Akter" subtitle
│ └────────────────────────────────────────┘ │
│ ┌────────────────────────────────────────┐ │
│ │ ⌁  টিফিন  12:20–12:50                   │ │  ← non-teaching: 40px, muted, no actions
│ └────────────────────────────────────────┘ │
│ ┌────────────────────────────────────────┐ │
│ │ 6th  12:50–13:30           ফাঁকা        │ │  ← free period: dashed border, no fill
│ └────────────────────────────────────────┘ │
│                                             │
│  আজ: ৫টি ক্লাস · ২টি বাকি · ১টি বদলি        │  day summary strip
├────────────────────────────────────────────┤
│  🏠রুটিন  ✓হাজিরা  📝খাতা  🤖শিক্ষক  👤    │  56px bottom nav, 5 items max
└────────────────────────────────────────────┘
```

### 6.2 Interaction rules

| Rule | Rationale |
|---|---|
| The **"now" card auto-scrolls into view** on open, with the next class pinned below it | The teacher's question is always "what's now and what's next" |
| Every action on a card works **offline**; the ⚡ chip shows queued-op count and never blocks | Signal in a concrete school building is unreliable even when the campus has wi-fi |
| **Attendance is one tap from the schedule**, pre-scoped to that section+period | Removes the top friction point; drives daily active use |
| Tap a card → detail sheet (bottom sheet, 90 % height) with roster, syllabus progress, lesson plan | Progressive disclosure keeps the list scannable |
| Long-press a card → "request substitution" / "mark class not held" | Secondary actions stay out of the primary flow |
| Substitution cards are visually distinct (amber) and **always sort in place**, never at the top | Time order is the only order a teacher thinks in |
| Pull-to-refresh triggers a sync **and** shows what changed since last view | Makes sync legible instead of magic |
| Weekly tab = horizontally scrollable 6-column grid, sticky period column, snap-to-day | A week grid is unreadable at 360 px without snapping |

### 6.3 States

- **Offline, data cached** → full function, ⚡ chip amber, "শেষ সিঙ্ক: ৭:০২".
- **Offline, no cached day** (first run offline) → skeleton + "ইন্টারনেট প্রয়োজন" with a retry;
  this is the only genuinely blocked state and the onboarding flow forces one online sync.
- **Routine changed while offline** → on sync, a non-blocking banner: "আপনার রুটিন পরিবর্তিত হয়েছে —
  ২টি পিরিয়ড" with a diff sheet.
- **Substitution assigned to you** → push + SMS + the card appears with a one-time highlight ring.

### 6.4 Coordinator surfaces (tablet/desktop, 1024 px+)

- **Master grid**: rows = periods, columns = sections, cell = subject+teacher. Filter by teacher
  or room to re-pivot the same grid. Drag-drop with live clash shading (§4.2).
- **Coverage board** (the daily driver): "6 periods need cover today" — a queue with inline
  ranked candidates, keyboard-navigable, bulk auto-assign.
- **Load heatmap**: teachers × days, colour = period count, flags anyone over cap or under-utilised.
- **Syllabus progress**: sections × subjects, % of chapters logged, red where the term is 60 %
  elapsed and coverage is under 40 %.

---

## 7. RMS API surface

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/rms/routines` | Create a draft routine for a term/shift |
| `POST` | `/rms/routines/{id}/generate` | Run the solver (async → job id + SSE progress) |
| `GET` | `/rms/routines/{id}?view=section\|teacher\|room` | Read a routine in any pivot |
| `POST` | `/rms/routines/{id}/validate-placement` | Real-time clash check (§4.3) |
| `POST` | `/rms/routines/{id}/moves` | Apply a move with local repair |
| `POST` | `/rms/routines/{id}/publish` | Version + activate at `effectiveFrom` |
| `GET` | `/rms/routines/{id}/diff/{versionA}/{versionB}` | Change review before publish |
| `GET` | `/rms/teachers/{id}/day?date=` | Teacher day view (the PWA's main read) |
| `GET` | `/rms/teachers/{id}/week?weekOf=` | Week grid |
| `POST` | `/rms/leaves` | Teacher/coordinator files leave → triggers cover search |
| `GET` | `/rms/substitutions/candidates` | Ranked cover candidates (§5.4) |
| `POST` | `/rms/substitutions` | Assign / cancel / merge |
| `GET` | `/rms/reports/coverage?from=&to=` | Classes held vs scheduled |
| `GET` | `/rms/reports/load` | Teacher load heatmap data |

All read endpoints are `sync`-aware: passing `If-None-Match` with the client's cursor returns
`304` on a 2G-friendly empty body.
