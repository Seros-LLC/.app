import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeDueDate, resolveOwner } from '../src/sanitize';

const NOW = new Date('2026-08-18T12:00:00Z');   // a Tuesday

test('drops a hallucinated date the text never mentions', () => {
  assert.equal(sanitizeDueDate('We will ship the billing fix before the demo on Friday.', '2023-04-21', NOW), null);
});
test('drops any date in the past', () => {
  assert.equal(sanitizeDueDate('Due 2020-01-01', '2020-01-01', NOW), null);
});
test('keeps an explicit ISO date written in the message', () => {
  assert.equal(sanitizeDueDate('Please deliver by 2026-09-01.', '2026-09-01', NOW), '2026-09-01');
});
test('keeps a numeric date written in the message', () => {
  assert.equal(sanitizeDueDate('deck due 9/1', '2026-09-01', NOW), '2026-09-01');
});
test('keeps "tomorrow" when the date really is tomorrow', () => {
  assert.equal(sanitizeDueDate("I'll fix it tomorrow.", '2026-08-19', NOW), '2026-08-19');
});
test('drops "tomorrow" when the date is not tomorrow', () => {
  assert.equal(sanitizeDueDate("I'll fix it tomorrow.", '2026-08-25', NOW), null);
});
test('keeps a named weekday only if the date is that weekday within a week', () => {
  assert.equal(sanitizeDueDate('deck by Thursday', '2026-08-20', NOW), '2026-08-20'); // Thu
  assert.equal(sanitizeDueDate('deck by Thursday', '2026-08-21', NOW), null);          // Fri
});
test('rejects malformed dates', () => {
  assert.equal(sanitizeDueDate('whenever', 'next friday', NOW), null);
  assert.equal(sanitizeDueDate('whenever', null, NOW), null);
});

const roster = [{ id: 'u-ana', name: 'Ana' }, { id: 'u-bo', name: 'Bo' }];
test('owner falls back to the author when the proposal is not a known member', () => {
  const r = resolveOwner('Priya', 'u-ana', roster);
  assert.equal(r.owner, 'u-ana');
  assert.equal(r.mapping, 'author_fallback');
});
test('owner is used when it maps to a real member by id or name', () => {
  assert.equal(resolveOwner('u-bo', 'u-ana', roster).owner, 'u-bo');
  assert.equal(resolveOwner('Bo', 'u-ana', roster).owner, 'u-bo');
  assert.equal(resolveOwner('bo', 'u-ana', roster).mapping, 'explicit');
});
test('null proposal falls back to the author', () => {
  assert.equal(resolveOwner(null, 'u-ana', roster).owner, 'u-ana');
});
