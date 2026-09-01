/**
 * The audit writer.  (R-3)
 *
 * `audit.activity_log` has existed since migration 001 and nothing wrote to
 * it until R-3. The two properties worth holding are the ones that would be
 * discovered late and badly:
 *
 *   1. A failing audit insert must NOT fail the operation it narrates.
 *      Losing a log line is bad; a logging error that stops a school
 *      promoting its students is much worse, and the domain tables still
 *      hold the fact.
 *   2. Every row carries the actor's tenant, so it lands under the same RLS
 *      as the mutation and cannot reach another school's history.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { writeAudit, type AuditClient } from '../src/audit.ts';

const actor = { tenantId: 't-1', userId: 'u-1', role: 'principal' };

/** Records what was sent so a test can assert on the SQL parameters. */
function spy(behaviour: 'ok' | 'throw' = 'ok') {
  const all: { text: string; values?: unknown[] }[] = [];
  const client: AuditClient = {
    async query(text: string, values?: unknown[]) {
      all.push({ text, values });
      if (behaviour === 'throw') throw new Error('relation "audit.activity_log" does not exist');
      return {};
    },
  };
  // The audit INSERTs, not every statement. `writeAudit` also brackets its
  // insert with a SAVEPOINT (see the transaction suite below for why), and
  // these assertions are about what is RECORDED, not about call order — an
  // index into every statement would break on any future bracketing too.
  const calls = {
    get length() { return all.filter(isInsert).length; },
    at(i: number) { return all.filter(isInsert)[i]; },
    [Symbol.iterator]() { return all.filter(isInsert)[Symbol.iterator](); },
  };
  return { client, calls, all };
}

const isInsert = (c: { text: string }) => c.text.includes('INSERT INTO audit.activity_log');

describe('writeAudit', () => {
  test('THE ONE THAT MATTERS — a failing audit never throws', async () => {
    const { client } = spy('throw');
    // No assert.rejects here: the point is that it resolves. If this ever
    // starts throwing, a database hiccup takes the rollover with it.
    await writeAudit(client, actor, {
      action: 'academic.rollover.commit',
      entityType: 'year_rollover',
      entityId: 'r-1',
    });
  });

  test('the actor’s tenant, id and role are on every row', async () => {
    const { client, calls } = spy();
    await writeAudit(client, actor, {
      action: 'ops.user.create', entityType: 'user', entityId: 'u-2',
    });
    const [tenantId, actorId, actorRole, action, entityType, entityId] = calls.at(0)!.values!;
    assert.equal(tenantId, 't-1');
    assert.equal(actorId, 'u-1');
    assert.equal(actorRole, 'principal');
    assert.equal(action, 'ops.user.create');
    assert.equal(entityType, 'user');
    assert.equal(entityId, 'u-2');
  });

  test('it INSERTs and never UPDATEs — a trail that can be edited is not one', async () => {
    // Asserted over EVERY statement, not just the insert: the claim is that
    // this function cannot rewrite history, and a savepoint rollback is the
    // only thing it is allowed to undo.
    const { client, all } = spy();
    await writeAudit(client, actor, { action: 'ops.settings.update', entityType: 'tenant' });
    assert.ok(all.some((c) => /INSERT INTO audit\.activity_log/.test(c.text)));
    for (const c of all) {
      assert.doesNotMatch(c.text, /UPDATE|DELETE/,
        'the audit trail is append-only');
    }
  });

  test('before and after are serialised as JSON, and absent when not given', async () => {
    const { client, calls } = spy();
    await writeAudit(client, actor, {
      action: 'academic.class_teacher.assign',
      entityType: 'section',
      entityId: 'sec-1',
      before: { teacherId: 'a' },
      after: { teacherId: 'b' },
    });
    assert.equal(calls.at(0)!.values![6], '{"teacherId":"a"}');
    assert.equal(calls.at(0)!.values![7], '{"teacherId":"b"}');

    await writeAudit(client, actor, { action: 'ops.user.deactivate', entityType: 'user' });
    assert.equal(calls.at(1)!.values![6], null, 'an omitted state is NULL, not the string "undefined"');
    assert.equal(calls.at(1)!.values![7], null);
  });

  test('a missing entityId is NULL rather than the string "undefined"', async () => {
    const { client, calls } = spy();
    await writeAudit(client, actor, { action: 'ops.settings.update', entityType: 'tenant' });
    assert.equal(calls.at(0)!.values![5], null);
  });

  test('an explicit null before-state is preserved as JSON null', async () => {
    // "there was nobody in this role before" is a fact worth recording, and
    // it must not be confused with "we did not look".
    const { client, calls } = spy();
    await writeAudit(client, actor, {
      action: 'academic.subject_teacher.assign', entityType: 'section',
      entityId: 's', before: null, after: { teacherId: 'b' },
    });
    assert.equal(calls.at(0)!.values![6], 'null');
  });
});

describe('writeAudit — and the caller’s transaction', () => {
  /**
   * "Never throws" was implemented as a bare `catch`, and inside a transaction
   * that is a trap rather than a safety net. PostgreSQL aborts the WHOLE
   * transaction on any statement error, so swallowing the exception leaves the
   * caller running in a poisoned transaction whose COMMIT silently becomes a
   * ROLLBACK — it loses its own write and reports success.
   *
   * Found in P5: B-7's revocation endpoint passed a composite string as
   * `entityId` into a `uuid` column and returned 200, carrying a real
   * timestamp, for a revocation that had not happened. Nothing logged an
   * error. Every other call site in this repo had the same exposure.
   */
  const actor = { tenantId: 't', userId: 'u', role: 'principal' };

  /** A client that fails only the audit INSERT, as a real database would. */
  function txSpy() {
    const calls: string[] = [];
    const client: AuditClient = {
      async query(text: string) {
        calls.push(text.trim().split(String.fromCharCode(10))[0].trim());
        if (text.includes('INSERT INTO audit.activity_log')) {
          throw new Error('invalid input syntax for type uuid');
        }
        return {};
      },
    };
    return { client, calls };
  }

  test('THE ONE THAT MATTERS — a failed audit is rolled back to its savepoint', async () => {
    const { client, calls } = txSpy();
    await writeAudit(client, actor, {
      action: 'ops.guardian.revoke', entityType: 'guardianship', entityId: 'not-a-uuid',
    });
    assert.ok(calls.some((c) => c.startsWith('SAVEPOINT ')),
      'the insert must be scoped before it is attempted');
    assert.ok(calls.some((c) => c.startsWith('ROLLBACK TO SAVEPOINT ')),
      'without this the caller silently loses its own write at COMMIT');
    // And it still does not throw — the original contract is intact.
  });

  test('a successful audit releases its savepoint rather than leaving it open', async () => {
    const calls: string[] = [];
    const client: AuditClient = {
      async query(text: string) { calls.push(text.trim().split(String.fromCharCode(10))[0].trim()); return {}; },
    };
    await writeAudit(client, actor, { action: 'ops.settings.update', entityType: 'tenant' });
    assert.ok(calls.some((c) => c.startsWith('RELEASE SAVEPOINT ')),
      'a transaction with hundreds of open savepoints is a slow one');
  });

  test('two audits in one transaction do not share a savepoint name', async () => {
    // Nested or repeated audit writes must not release each other's scope.
    const names: string[] = [];
    const client: AuditClient = {
      async query(text: string) {
        const m = /^SAVEPOINT (\S+)/.exec(text.trim());
        if (m) names.push(m[1]);
        return {};
      },
    };
    await writeAudit(client, actor, { action: 'ops.settings.update', entityType: 'tenant' });
    await writeAudit(client, actor, { action: 'ops.settings.update', entityType: 'tenant' });
    assert.equal(new Set(names).size, 2, names.join(', '));
  });

  test('a client with no transaction still records, and still cannot throw', async () => {
    // A bare pool client rejects SAVEPOINT. That must not stop the row being
    // written, and must not surface as an error either.
    const inserts: string[] = [];
    const client: AuditClient = {
      async query(text: string) {
        if (text.startsWith('SAVEPOINT') || text.includes('SAVEPOINT ')) {
          throw new Error('SAVEPOINT can only be used in transaction blocks');
        }
        inserts.push(text.trim().split(String.fromCharCode(10))[0].trim());
        return {};
      },
    };
    await writeAudit(client, actor, { action: 'ops.settings.update', entityType: 'tenant' });
    assert.ok(inserts.some((c) => c.includes('INSERT INTO audit.activity_log')));
  });
});
