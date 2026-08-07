# @shikhon/offline

The outbox and sync engine behind the PWA's offline-first behaviour.
Implements [docs/01-ARCHITECTURE.md](../../docs/01-ARCHITECTURE.md) §2.3–2.6.

**Zero runtime dependencies.** `fake-indexeddb` is a devDependency only.

## The contract

1. **`enqueue()` never awaits the network.** It resolves once the op is durable
   locally (~ms). A teacher tapping "save attendance" with no signal sees no
   difference from one on wi-fi.
2. **An op leaves the outbox only on a server acknowledgement** — `applied` or
   `duplicate`. Transport failure, a silent omission, an exhausted retry budget:
   none of them delete anything. *Zero offline op loss is an absolute SLO*,
   because an attendance record that vanishes is a parent who was never told.
3. **Flushing is single-flight.** Two tabs, or a tab and the service worker,
   must never send the same batch.

## Usage

```ts
import { SyncEngine, IndexedDbOutboxStore, openDb } from '@shikhon/offline';

const engine = new SyncEngine({
  deviceId, tenantId, actorId,
  store: new IndexedDbOutboxStore(await openDb(indexedDB)),
  transport: { push: (req) => fetch('/api/v1/sync/push', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  }).then((r) => r.json()) },
  onProgress: (s) => setSyncChip(s),   // drives the ⚡ chip
});

// Taking attendance — no await on the network anywhere in this path.
await engine.enqueue({ entity: 'attendance_record', payload: { sessionId, studentId, status } });
await engine.flush();                  // also called from a Background Sync handler
```

## Design notes

**UUIDv7, not v4.** Op ids double as primary keys on `attendance_sessions`,
`answer_scripts` and `class_delivery_log`. A time-ordered key gives sequential
B-tree inserts instead of scattering writes across the index — on a 150M-row
partitioned table that is an append versus constant page splits.

**Full jitter on backoff.** The failure mode that matters is a whole school's
devices rejoining a flaky tower at the same instant. Without jitter they retry
in lockstep and re-collapse the link.

**Clock skew is corrected, not trusted.** Cheap Android devices drift by
minutes, and attendance conflict resolution compares client timestamps. Every
`occurredAt` is stamped on the server-aligned clock.

**Conflicts are per-entity, not last-writer-wins.** Some of these writes have
already had irreversible effects: a present→absent flip *after* the absence SMS
has gone out appends a correction instead of mutating history, and a published
exam result is a legal document that the server always wins.

## Tests

```bash
cd packages/offline && npm test
```

46 assertions. The store contract runs against **both** `MemoryOutboxStore` and
`IndexedDbOutboxStore` — the one that ships must not be the untested one.
Highlights: no op loss on transport failure, ops the server silently omits are
retried, concurrent flushes collapse to one, the retry budget parks rather than
deletes, and a 60-student section marked with no signal at 07:10 delivers
completely and without duplicates when the tower returns at 11:40.
