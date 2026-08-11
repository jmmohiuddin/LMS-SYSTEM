/**
 * F-902 media preparation.
 *
 * The compression ladder is the part that decides whether a student on 3G
 * ever gets their homework submitted, and it is the part a browser-only
 * implementation would never have checked. With the encoder injected these
 * are ordinary tests: give it a camera that produces known sizes and assert
 * which rung it stops on.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  planCompression, checkMedia, formatDuration,
  MAX_MEDIA_BYTES, MAX_VOICE_MS, SCALE_LADDER, QUALITY_LADDER,
} from '../src/media.ts';

describe('F-902 compression ladder', () => {
  test('stops at the first rung that fits, without trying smaller ones', async () => {
    const tried: Array<[number, number]> = [];
    // A well-lit page that already compresses well: fits at full scale.
    const plan = await planCompression(async (edge, q) => {
      tried.push([edge, q]);
      return 100_000;
    });
    assert.ok(plan);
    assert.equal(plan.longestEdge, SCALE_LADDER[0]);
    assert.equal(plan.quality, QUALITY_LADDER[0]);
    assert.equal(plan.attempts, 1);
    assert.equal(tried.length, 1, 'must not keep encoding after it fits');
  });

  test('exhausts quality before dropping resolution', async () => {
    const tried: Array<[number, number]> = [];
    // Only the third quality step at the first scale gets under the ceiling.
    const plan = await planCompression(async (edge, q) => {
      tried.push([edge, q]);
      return q <= 0.48 ? 200_000 : 400_000;
    });
    assert.ok(plan);
    // Legibility is the reason to photograph handwriting at all, so
    // resolution is the last thing given up.
    assert.equal(plan.longestEdge, SCALE_LADDER[0], 'resolution held');
    assert.equal(plan.quality, 0.48);
    assert.deepEqual(tried.map((t) => t[0]), [1600, 1600, 1600]);
  });

  test('drops resolution only once quality is spent', async () => {
    const plan = await planCompression(async (edge) => (edge <= 1024 ? 240_000 : 900_000));
    assert.ok(plan);
    assert.equal(plan.longestEdge, 1024);
    // Three qualities at 1600, three at 1280, then the first at 1024.
    assert.equal(plan.attempts, 7);
  });

  test('returns null rather than uploading something that cannot complete', async () => {
    const plan = await planCompression(async () => 5_000_000);
    assert.equal(plan, null);
  });

  test('a zero-byte encode is never accepted as fitting', async () => {
    // 0 <= MAX would pass a naive bounds check and submit an empty file.
    const plan = await planCompression(async () => 0);
    assert.equal(plan, null);
  });
});

describe('F-902 media validation', () => {
  test('accepts a photo at the ceiling and rejects one past it', () => {
    assert.equal(checkMedia({ kind: 'photo', bytes: MAX_MEDIA_BYTES }), null);
    assert.equal(checkMedia({ kind: 'photo', bytes: MAX_MEDIA_BYTES + 1 }), 'too_large');
  });

  test('a photo carrying a duration is a client that confused its payloads', () => {
    assert.equal(checkMedia({ kind: 'photo', bytes: 1000, durationMs: 5000 }), 'kind_mismatch');
  });

  test('voice needs a duration, and 90 seconds is the ceiling', () => {
    assert.equal(checkMedia({ kind: 'voice', bytes: 1000 }), 'empty');
    assert.equal(checkMedia({ kind: 'voice', bytes: 1000, durationMs: MAX_VOICE_MS }), null);
    assert.equal(checkMedia({ kind: 'voice', bytes: 1000, durationMs: MAX_VOICE_MS + 1 }), 'too_long');
  });

  test('an empty capture is rejected before it reaches the outbox', () => {
    assert.equal(checkMedia({ kind: 'photo', bytes: 0 }), 'empty');
    assert.equal(checkMedia({ kind: 'photo', bytes: -1 }), 'empty');
  });

  test('a malformed hash is caught here rather than at the database', () => {
    assert.equal(checkMedia({ kind: 'photo', bytes: 100, sha256: 'nope' }), 'hash_invalid');
    assert.equal(checkMedia({ kind: 'photo', bytes: 100, sha256: 'a'.repeat(64) }), null);
  });
});

describe('F-902 recorder readout', () => {
  test('counts in Bangla digits, because a student reads it', () => {
    assert.equal(formatDuration(0), '০:০০');
    assert.equal(formatDuration(9000), '০:০৯');
    assert.equal(formatDuration(65000), '১:০৫');
    assert.equal(formatDuration(MAX_VOICE_MS), '১:৩০');
  });

  test('never shows a negative clock', () => {
    assert.equal(formatDuration(-500), '০:০০');
  });
});
