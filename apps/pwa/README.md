# @shikhon/pwa

The offline-first shell. Framework-free on purpose: the critical path is
budgeted at 180 KB gzipped for a 2 GB Android Go device on 2G, and the
attendance screen is ~4 KB of DOM code.

## What is here

| File | Role |
|---|---|
| `src/attendance-view.ts` | The 30-second screen. Binds `AttendanceGrid` (state) to `SyncEngine` (durability). |
| `src/sw-router.ts` | Service-worker **policy** — pure and unit-tested. |
| `src/sw.ts` | Service-worker **glue** — install/activate/fetch/sync wiring. |
| `public/` | App shell, CSS tokens, manifest. |

## The rule this screen exists to prove

**Saving never awaits the network.** `save()` writes to the outbox and returns;
the flush happens in the background and is allowed to fail. A teacher at 07:10
with no signal sees exactly what one on wi-fi sees, and the ⚡ chip reports
queued work rather than an error.

`save()` returns `{ opId, queued, flushed }`. The UI ignores `flushed`; a
"sync now" button — or a test — awaits it, because the engine's single-flight
mutex will otherwise silently collapse a caller's own flush into the running one.

## Accessibility

Tiles are `role="checkbox"` buttons at 56 × 56 px inside a labelled group,
arrow-key navigable, with `aria-label`s that state the status **in words** —
colour is never the only signal. Labels stay short and use everyday Bangla,
because TalkBack's Bangla TTS is materially worse than its English.

```bash
npm test    # 27 assertions, jsdom
```

The complete chain — DOM tap → outbox → server → PostgreSQL — is covered by
[`services/sync-svc/test/vertical-slice.test.ts`](../../services/sync-svc/test/vertical-slice.test.ts).
