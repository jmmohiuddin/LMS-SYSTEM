# Pilot Onboarding Runbook — the first 3–5 institutions

**Audience:** the platform operator, onboarding a school by hand.
**Status:** **the fallback.** R-7 shipped 2026-08-29 — the normal path is now the
console at **`/platform`**, which does every step below through a nine-step
wizard with no SQL at all. See [11-MASTER-PLAN.md](11-MASTER-PLAN.md) §R-7 and
the R-7 entry of [PHASE_LOG.md](PHASE_LOG.md).

> **Use this document when the console is not available to you** — a deployment
> where `PLATFORM_API_KEY` or `PLATFORM_DATABASE_URL` is not configured (the
> service answers 503 rather than falling back), or a recovery where you have a
> database and nothing else. The steps and their order are unchanged, because the
> wizard performs exactly these operations.

> **Doing it by hand first was worth it.** Two of the three gaps R-7 found are
> gaps this runbook would have hit at step 6, on a real school's data:
> `provision_tenant` leaves no subject template, so the student import in §6
> would have rejected *every row*; and nothing in the product had ever written
> `student_profiles`, so the permanent student IDs this document promises would
> not have existed. Both are fixed. If you are following this runbook on a
> deployment that has migration 045, call `app.provision_curriculum(<tenant>)`
> after `app.provision_tenant(...)` in §3 — the console does it automatically.

---

## 0. Before you start

**You need**

- [ ] A signed agreement with the institution. *There is no self-service signup and
      R-7 does not add one — tenant creation is always a deliberate act by us.*
- [ ] `DATABASE_MIGRATION_URL` or an owner-role connection string
      (see [06-DEPLOYMENT.md](06-DEPLOYMENT.md) §2). Steps 1–2 are the only ones
      that need it.
- [ ] The institution's basics: Bangla + English name, type, level, district,
      address, head teacher's name and phone.
- [ ] Their student list as CSV — see §6 for the columns. **Ask for this first.**
      It is the long pole: a school's spreadsheet has been maintained by hand for
      six years and needs a week of their time, not ours.

**Time:** 30–60 minutes of operator work once the CSV is in hand.

**Rule for the whole runbook:** every SQL block runs inside the tenant's own
context. `SET LOCAL app.tenant_id` is not optional — `app.provision_tenant()`
refuses to run without it (error `42501`), and RLS silently returns zero rows for
everything else. If a statement seems to do nothing, check the context first.

---

## 1. Decide the slug

The slug becomes the school's web address at R-7 (`monipur-high.shikhonbd.com`)
and is `citext UNIQUE` today. **Treat it as permanent from the moment it is
printed on anything.**

- Lowercase the English name, replace runs of non-alphanumerics with `-`.
- Must match `^[a-z0-9][a-z0-9-]{2,62}$`.
- `Monipur High School` → `monipur-high-school`.
- On collision, add the district (`monipur-high-dhaka`), **not** a number.
  `monipur-high-2` is not a URL anyone will print on an admission slip.

Check it is free:

```sql
SELECT slug FROM tenants WHERE slug = 'monipur-high-school';
-- (owner role; the runtime role cannot see other tenants by design)
```

---

## 2. Create the tenant

One statement. Note the weekend: **madrasahs are commonly Friday only** (`{5}`),
while schools and colleges are Friday+Saturday (`{5,6}`). Getting this wrong makes
attendance suppression and the SMS holiday rules wrong all year.

```sql
INSERT INTO tenants (
  slug, name_bn, name_en,
  stream, level,
  district, upazila, address_bn,
  eiin, board_code,
  weekend_days, shifts,
  status, plan_code, student_cap, trial_ends_on
) VALUES (
  'monipur-high-school',
  'মনিপুর উচ্চ বিদ্যালয়', 'Monipur High School',
  'bangla_medium',            -- bangla_medium | english_version | english_medium | madrasah | technical
  'secondary',                -- primary | junior_secondary | secondary | higher_secondary | combined
  'ঢাকা', 'মিরপুর', 'মিরপুর-২, ঢাকা ১২১৬',
  '108234',                   -- EIIN, globally unique; NULL if unknown
  'dhaka',
  '{5,6}'::smallint[],        -- madrasah: '{5}'
  '{morning,day}'::shift_code[],
  'trial', 'pilot', 1500, CURRENT_DATE + 180
)
RETURNING id, slug;
```

**Record the returned `id`.** It is the tenant key for every step below and for
the school's login link.

| Failure | Meaning | Do |
|---|---|---|
| `duplicate key … tenants_slug_key` | Slug taken | Pick a district-suffixed alternative (§1) |
| `duplicate key … tenants_eiin_key` | EIIN already registered | Verify the number with the school; do not invent one. `NULL` is acceptable |
| `violates check constraint … slug` | Slug pattern | Lowercase, ≥3 chars, no leading `-` |

---

## 3. Provision the academic structure

One call, idempotent, inside the tenant's context.

```sql
BEGIN;
SET LOCAL app.tenant_id = '<tenant-id from step 2>';
SET LOCAL app.role      = 'principal';

SELECT * FROM app.provision_tenant(
  '<tenant-id>'::uuid,
  '2026',                       -- academic year label
  '2026-01-01'::date,
  '2026-12-31'::date,
  6::smallint,                  -- lowest class
  10::smallint                  -- highest class
);

-- R-7. provision_tenant does NOT create the subject templates that
-- app.derive_student_subjects() needs, so without this the student import in
-- §6 rejects every row with "বিষয় তালিকা (টেমপ্লেট) তৈরি হয়নি". The console
-- calls it automatically; by hand you must not forget it.
SELECT * FROM app.provision_curriculum('<tenant-id>'::uuid, NULL);
COMMIT;
```

It returns a table — **read it, do not skip it**:

```text
 created_object          | qty
-------------------------+-----
 academic_year           |   1
 terms                   |   3
 grading_bands           |   7     ← if this is 0, stop and investigate
 period_templates        |   2
 classes                 |   5
 class_subject_mappings  |  45
 fee_heads               |   5
```

> **`grading_bands` is the one to check.** Without them
> `app.compute_subject_grade()` returns NULL and the first result publication of
> the year fails — months later, with no obvious cause. Everything else can be
> fixed when noticed; this one hides.

Safe to re-run: every insert is `ON CONFLICT DO NOTHING`. If it raised `42501`,
the session context was wrong — set it and run again.

---

## 4. Create the head teacher and issue an activation code

The first account creates everything else, so it comes before any import.

```sql
BEGIN;
SET LOCAL app.tenant_id = '<tenant-id>';
SET LOCAL app.role      = 'principal';

INSERT INTO users (tenant_id, full_name_bn, full_name_en, phone_e164, status)
VALUES (app.current_tenant(), 'মোঃ আব্দুল কাদের', 'Md Abdul Kader',
        '+8801711000001', 'active')
RETURNING id;

INSERT INTO user_roles (tenant_id, user_id, role_code, scope_type)
VALUES (app.current_tenant(), '<user-id>', 'principal', 'tenant');
COMMIT;
```

Then issue their activation code over the API — **not** by writing to
`activation_codes` directly, because the code itself is never stored (only an HMAC
under `ACTIVATION_PEPPER`) and the endpoint is what generates it:

```bash
curl -sX POST "$BASE/api/v1/auth/activate" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $STAFF_TOKEN" \
  -d '{"action":"issue","userId":"<user-id>"}'
# → { "code": "K7M2-9QX4", "expiresAt": "…" }
```

Give the code to the head teacher **face to face or by phone**, not by email.
Single-use, 72-hour expiry, revocable. This is why pilot onboarding does not wait
on the SMS aggregator contract (R-8): the school itself is the identity authority.

*If `$STAFF_TOKEN` does not exist yet for a brand-new tenant, mint the first one
with the same owner-role session used above; every account after this one is
created from inside the app.*

---

## 5. Branding

Hand this to the school — it is their identity, and doing it for them means doing
it again when they see it.

1. Head teacher redeems the activation code at `/app?tid=<tenant-id>`.
2. Opens **প্রতিষ্ঠানের পরিচয়** (More menu, or the dashboard card).
3. Fills in: names, logo, colours, address, phone, head teacher's name, and —
   if they want branded receipts — signature and watermark.

**They can skip it entirely.** Migration 039 seeded `settings->'branding'` from
the tenant's own name and address, so the school already shows *its* name and
never the platform's. Blocking activation on a logo the office has not found is
how onboarding stalls for a week.

---

## 6. Student import

The school's own spreadsheet, as CSV. Bangla headers are accepted.

**Required columns** (any one alias per row):

| Field | Accepted headers |
|---|---|
| Roll | `roll_no` · `roll` · `রোল` |
| Name (Bangla) | `name_bn` · `name` · `নাম` |
| Class | `class` · `class_level` · `শ্রেণি` |
| Section | `section` · `শাখা` |
| Guardian phone | `guardian_phone` · `phone` · `মোবাইল` |

**Optional but worth asking for:** `name_en`, `gender`, `dob`, `birth_reg_no`,
`religion`, `optional_subject` (fourth subject), `guardian_name`, `relation`.

Import through the app — **আরও → শিক্ষার্থী আমদানি** — as the head teacher:

1. **Upload.** Nothing is written.
2. **Validate.** Per-row errors with line numbers; download the error CSV and send
   it back to the school to fix in the source spreadsheet.
3. **Preview.** The button states both numbers — *"৭৬৮টি ঠিক সারি আমদানি করুন,
   ১৬টি বাদ"*. There is no way to press it without reading how many students are
   being left out.
4. **Import.** Students, guardians and enrolments are written in one transaction
   and recorded in `import_batches`.

**Guardians are created here, not separately.** `guardian_phone` is the identity,
so two students sharing a phone become **one guardian with two children** — which
is the sibling case, and getting it wrong produces duplicate SMS and a parent who
cannot see one of their children.

| Failure | Meaning | Do |
|---|---|---|
| `ফাইলে আবশ্যক কলাম নেই` | A required column is missing | Add the header; aliases above |
| `digest_mismatch` | A different file was committed than was validated | Re-validate the file you intend to import |
| Roll collisions | Two rows claim one seat in a section | The school fixes the spreadsheet |
| Class/section not found | Section does not exist yet | Create sections, or correct the spelling in the CSV |

---

## 7. Teachers

Create teacher accounts the same way as step 4 (`users` + `user_roles` with
`subject_teacher` or `class_teacher`), and issue each an activation code.

**Section and subject assignment has no UI yet** — that is **R-3**. Until then,
insert `section_subject_teachers` rows directly, or leave assignment until R-3
ships. A pilot school can take attendance as soon as a class teacher is attached
to a section:

```sql
BEGIN;
SET LOCAL app.tenant_id = '<tenant-id>';
SET LOCAL app.role      = 'principal';
UPDATE sections SET class_teacher_id = '<teacher-user-id>'
 WHERE id = '<section-id>';
COMMIT;
```

---

## 8. Activate and hand over

```sql
BEGIN;
SET LOCAL app.tenant_id = '<tenant-id>';
SET LOCAL app.role      = 'principal';
UPDATE tenants SET status = 'active' WHERE id = app.current_tenant();
COMMIT;
```

Give the school:

- **Their link:** `https://<host>/app?tid=<tenant-id>` — to be printed on
  admission slips, sent in the school's own SMS, and put on the office wall as a
  QR code. This is their door; there is no school-picker and never will be (D12).
- **Install instructions:** open the link → browser menu → *Add to Home screen*.
  It installs as *their* school, with their name and icon.
- **Activation codes** for the staff who need them.

---

## 9. Verify before you call it done

- [ ] `/app?tid=<id>` login screen shows **the school's** name and logo
- [ ] Head teacher can redeem their code and reach the dashboard
- [ ] The top bar shows the institution's name
- [ ] Roster shows the imported students under the right class and section
- [ ] A guardian with two children sees **both**
- [ ] A teacher can take attendance and it survives going offline
- [ ] `grading_bands` is non-zero (step 3)
- [ ] Open a second pilot tenant in another browser profile and confirm **neither
      sees the other's name, logo, students or colours**

---

## 10. When something goes wrong

| Situation | What to do |
|---|---|
| Wrong details after creation | `UPDATE tenants SET …` inside the tenant context. Everything except `id` is editable |
| Wrong slug, already printed | Painful. Keep the old slug; `?tid=` links are unaffected because they carry the id, not the slug |
| Provisioning ran with the wrong class range | Re-run `provision_tenant` with the right range — it is additive and idempotent. Extra classes can be deleted while empty |
| Import went in wrong | Delete the enrolments and students of that `import_batches` row inside the tenant context, then re-import. Do this **before** any attendance or marks reference them |
| Onboarding abandoned mid-way | `UPDATE tenants SET status = 'archived'`. It disappears from every login screen (`app.public_branding()` excludes archived) and can be removed later under retention policy |
| **Never** | Hard-delete a tenant that has student rows, except through the PDPA erasure path. Historical records are the product |

---

## 11. What to write down for R-7

After each pilot school, record:

- Which fields the office **could not supply** on day one
- Which error messages were **misread**, and what they thought they meant
- How long each step actually took
- Any step done **out of order**, and why that was more natural
- Anything you had to explain twice

That list is what makes R-7's wizard fit the work instead of fitting this
document.
