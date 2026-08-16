import test from 'node:test';
import assert from 'node:assert/strict';
import { installDialog, openDialog } from '../src/lib/dialogs.js';

class FakeTarget {
  constructor({ connected = true } = {}) {
    this.isConnected = connected;
    this.focusCalls = 0;
    this.listeners = new Map();
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) || []) listener({ target: this, ...event });
  }
  focus() { this.focusCalls++; }
}

class FakeDialog extends FakeTarget {
  constructor() {
    super();
    this.open = false;
    this.showModalCalls = 0;
    this.closeCalls = 0;
    this.fallback = null;
  }
  showModal() { this.open = true; this.showModalCalls++; }
  close() {
    if (!this.open) return;
    this.open = false;
    this.closeCalls++;
    this.emit('close');
  }
  querySelector() { return this.fallback; }
}

test('opening a dialog focuses its initial control and restores its opener', () => {
  const dialog = new FakeDialog();
  const opener = new FakeTarget();
  const initialFocus = new FakeTarget();

  assert.equal(openDialog(dialog, { opener, initialFocus }), dialog);
  assert.equal(dialog.showModalCalls, 1);
  assert.equal(initialFocus.focusCalls, 1);
  assert.equal(opener.focusCalls, 0);

  dialog.close();
  assert.equal(opener.focusCalls, 1);
});

test('a disconnected opener is not focused after close', () => {
  const dialog = new FakeDialog();
  const opener = new FakeTarget({ connected: false });

  openDialog(dialog, { opener });
  dialog.close();

  assert.equal(opener.focusCalls, 0);
});

test('only a click on the dialog backdrop closes it', () => {
  const dialog = installDialog(new FakeDialog());
  const card = new FakeTarget();

  dialog.showModal();
  dialog.emit('click', { target: card });
  assert.equal(dialog.closeCalls, 0);

  dialog.emit('click', { target: dialog });
  assert.equal(dialog.closeCalls, 1);
});

test('installing a dialog twice does not duplicate close behavior', () => {
  const dialog = new FakeDialog();

  installDialog(dialog);
  installDialog(dialog);
  dialog.showModal();
  dialog.emit('click', { target: dialog });

  assert.equal(dialog.closeCalls, 1);
});
