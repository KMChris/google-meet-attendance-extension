import test from 'node:test';
import assert from 'node:assert/strict';
import { withExclusiveLock } from '../src/lib/locks.js';

const turn = () => new Promise(resolve => setTimeout(resolve, 0));

test('an exclusive lock runs queued work one at a time in FIFO order', async () => {
  const order = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });

  const first = withExclusiveLock('test-fifo', async () => {
    order.push('first-start');
    await gate;
    order.push('first-end');
  });
  const second = withExclusiveLock('test-fifo', async () => {
    order.push('second');
  });

  await turn();
  assert.deepEqual(order, ['first-start']);

  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-start', 'first-end', 'second']);
});

test('ifAvailable returns null while a fallback lock is owned', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const held = withExclusiveLock('test-skip', () => gate);

  await turn();
  assert.equal(
    await withExclusiveLock('test-skip', () => 'ran', { ifAvailable: true }),
    null
  );

  release();
  await held;
  assert.equal(await withExclusiveLock('test-skip', () => 'ran', { ifAvailable: true }), 'ran');
});

test('a rejected task releases the fallback lock for its next waiter', async () => {
  const first = withExclusiveLock('test-rejection', async () => {
    throw new Error('expected failure');
  });
  const second = withExclusiveLock('test-rejection', async () => 'recovered');

  await assert.rejects(first, /expected failure/);
  assert.equal(await second, 'recovered');
});
