/**
 * Exclusive work shared by extension contexts through Web Locks.
 *
 * Node tests and runtimes without Web Locks use a module-local FIFO queue. That fallback only
 * coordinates callers in this JavaScript context; Chrome pages and the service worker use the
 * browser lock manager because they share the extension origin.
 */

const fallbackQueues = new Map();

function drain(name, state) {
  if (state.active) return;
  const next = state.waiters.shift();
  if (!next) {
    if (fallbackQueues.get(name) === state) fallbackQueues.delete(name);
    return;
  }

  state.active = true;
  Promise.resolve()
    .then(next.task)
    .then(next.resolve, next.reject)
    .finally(() => {
      state.active = false;
      drain(name, state);
    });
}

export async function withExclusiveLock(name, task, { ifAvailable = false } = {}) {
  if (globalThis.navigator?.locks?.request) {
    return navigator.locks.request(name, { mode: 'exclusive', ifAvailable }, lock => {
      if (!lock) return null;
      return task();
    });
  }

  const state = fallbackQueues.get(name) || { active: false, waiters: [] };
  fallbackQueues.set(name, state);
  if (ifAvailable && (state.active || state.waiters.length)) return null;

  return new Promise((resolve, reject) => {
    state.waiters.push({ task, resolve, reject });
    drain(name, state);
  });
}
