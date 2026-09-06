/**
 * tests/sanitize.test.ts - Guards over model output.
 *
 * sanitizeDueDate() and resolveOwner() enforce two product promises from
 * DATA-MODEL.md and src/sanitize.ts: a due date is kept only when the message
 * text actually anchors it (never guessed), and an owner is accepted only when
 * it maps to a real member (otherwise the author owns the commitment).
 *
 * These are pure functions with no I/O, so the tests pin an explicit `now` and
 * assert behaviour directly. `now` is fixed to 2026-09-06 (a Sunday, UTC) so the
 * weekday cases are deterministic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeDueDate, resolveOwner } from '../src/sanitize';

const NOW = new Date('2026-09-06T12:00:00Z'); // Sunday, UTC

test('sanitizeDueDate drops a null or malformed proposal', () => {
  assert.equal(sanitizeDueDate('whatever', null, NOW), null);
  assert.equal(sanitizeDueDate('due 9/10/2026', '9/10/2026', NOW), null); // not YYYY-MM-DD
  assert.equal(sanitizeDueDate('due 2026-9-1', '2026-9-1', NOW), null); // unpadded
  assert.equal(sanitizeDueDate('due soon', '', NOW), null);
});

test('sanitizeDueDate refuses an invalid calendar date even when well shaped', () => {
  // 2026-02-30 matches the YYYY-MM-DD shape but is not a real day; JS rolls it
  // to March 2, which is in the past relative to NOW, so it is dropped.
  assert.equal(sanitizeDueDate('by 2026-02-30', '2026-02-30', NOW), null);
});

test('sanitizeDueDate never keeps a date in the past', () => {
  assert.equal(sanitizeDueDate('due 2020-01-01', '2020-01-01', NOW), null);
  // yesterday, even with an explicit ISO date in the text
  assert.equal(sanitizeDueDate('was due 2026-09-05', '2026-09-05', NOW), null);
});

test('sanitizeDueDate rejects dates more than a year out', () => {
  // > 365 days from NOW is dropped even though the text states the ISO date
  assert.equal(sanitizeDueDate('ship by 2027-10-01', '2027-10-01', NOW), null);
  // just inside a year is kept when the text anchors it
  assert.equal(sanitizeDueDate('ship by 2027-09-01', '2027-09-01', NOW), '2027-09-01');
});

test('sanitizeDueDate keeps a date the text states explicitly', () => {
  assert.equal(sanitizeDueDate('ship by 2026-09-10 please', '2026-09-10', NOW), '2026-09-10');
  assert.equal(sanitizeDueDate('due 9/10 or so', '2026-09-10', NOW), '2026-09-10');
  assert.equal(sanitizeDueDate('due 9.10.26', '2026-09-10', NOW), '2026-09-10');
  assert.equal(sanitizeDueDate('due by Sep 10', '2026-09-10', NOW), '2026-09-10');
  assert.equal(sanitizeDueDate('due by September 10', '2026-09-10', NOW), '2026-09-10');
});

test('sanitizeDueDate honours today and tomorrow only when they line up', () => {
  assert.equal(sanitizeDueDate('need it today', '2026-09-06', NOW), '2026-09-06');
  assert.equal(sanitizeDueDate('do it tomorrow', '2026-09-07', NOW), '2026-09-07');
  // keyword present but the proposed date does not match the keyword -> dropped
  assert.equal(sanitizeDueDate('do it tomorrow', '2026-09-09', NOW), null);
  assert.equal(sanitizeDueDate('need it today', '2026-09-07', NOW), null);
});

test('sanitizeDueDate accepts a named weekday only when the date really is that weekday', () => {
  // 2026-09-11 is a Friday, within a week of Sunday NOW
  assert.equal(sanitizeDueDate('by friday', '2026-09-11', NOW), '2026-09-11');
  // 2026-09-10 is a Thursday, so "friday" does not anchor it
  assert.equal(sanitizeDueDate('by friday', '2026-09-10', NOW), null);
  // correct weekday but more than a week out -> dropped
  assert.equal(sanitizeDueDate('by friday', '2026-09-18', NOW), null);
});

test('sanitizeDueDate drops relative, vague, or hallucinated dates', () => {
  assert.equal(sanitizeDueDate('do it soon', '2026-09-10', NOW), null);
  assert.equal(sanitizeDueDate('before the demo', '2026-09-10', NOW), null);
  assert.equal(sanitizeDueDate('sometime next sprint', '2026-09-15', NOW), null);
});

const MEMBERS = [
  { id: 'U1', name: 'Alice' },
  { id: 'U2', name: 'Bob' },
];

test('resolveOwner maps an explicit proposal to a real member', () => {
  assert.deepEqual(resolveOwner('Alice', 'U9', MEMBERS), { owner: 'U1', mapping: 'explicit' });
  assert.deepEqual(resolveOwner('alice', 'U9', MEMBERS), { owner: 'U1', mapping: 'explicit' });
  assert.deepEqual(resolveOwner('  BOB  ', 'U9', MEMBERS), { owner: 'U2', mapping: 'explicit' });
  assert.deepEqual(resolveOwner('U2', 'U9', MEMBERS), { owner: 'U2', mapping: 'explicit' });
});

test('resolveOwner falls back to the author when the proposal is unknown or empty', () => {
  assert.deepEqual(resolveOwner('Zoe', 'U9', MEMBERS), { owner: 'U9', mapping: 'author_fallback' });
  assert.deepEqual(resolveOwner(null, 'U9', MEMBERS), { owner: 'U9', mapping: 'author_fallback' });
  assert.deepEqual(resolveOwner('', 'U9', MEMBERS), { owner: 'U9', mapping: 'author_fallback' });
  assert.deepEqual(resolveOwner('anyone', 'U9', [], ), { owner: 'U9', mapping: 'author_fallback' });
});
