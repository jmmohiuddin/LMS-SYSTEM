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
  const calls: { text: string; values?: unknown[] }[] = [];
  const client: AuditClient = {
    async query(text: string, values?: unknown[]) {
      calls.push({ text, values });
      if (behaviour === 'throw') throw new Error('relation "audit.activity_log" does not exist');
      return {};
    },
  };
  return { client, calls };
}

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
    const [tenantId, actorId, actorRole, action, entityType, entityId] = calls[0].values!;
    assert.equal(tenantId, 't-1');
    assert.equal(actorId, 'u-1');
    assert.equal(actorRole, 'principal');
    assert.equal(action, 'ops.user.create');
    assert.equal(entityType, 'user');
    assert.equal(entityId, 'u-2');
  });

  test('it INSERTs and never UPDATEs — a trail that can be edited is not one', async () => {
    const { client, calls } = spy();
    await writeAudit(client, actor, { action: 'ops.settings.update', entityType: 'tenant' });
    assert.match(calls[0].text, /INSERT INTO audit\.activity_log/);
    assert.doesNotMatch(calls[0].text, /UPDATE|DELETE/);
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
    assert.equal(calls[0].values![6], '{"teacherId":"a"}');
    assert.equal(calls[0].values![7], '{"teacherId":"b"}');

    await writeAudit(client, actor, { action: 'ops.user.deactivate', entityType: 'user' });
    assert.equal(calls[1].values![6], null, 'an omitted state is NULL, not the string "undefined"');
    assert.equal(calls[1].values![7], null);
  });

  test('a missing entityId is NULL rather than the string "undefined"', async () => {
    const { client, calls } = spy();
    await writeAudit(client, actor, { action: 'ops.settings.update', entityType: 'tenant' });
    assert.equal(calls[0].values![5], null);
  });

  test('an explicit null before-state is preserved as JSON null', async () => {
    // "there was nobody in this role before" is a fact worth recording, and
    // it must not be confused with "we did not look".
    const { client, calls } = spy();
    await writeAudit(client, actor, {
      action: 'academic.subject_teacher.assign', entityType: 'section',
      entityId: 's', before: null, after: { teacherId: 'b' },
    });
    assert.equal(calls[0].values![6], 'null');
  });
});
