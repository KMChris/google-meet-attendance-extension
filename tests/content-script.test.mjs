import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

process.env.TZ = 'Europe/Warsaw';

const SOURCE_PATH = new URL('../src/content/content-script.js', import.meta.url);

function splitSelectors(selector) {
  return String(selector).split(',').map(part => part.trim()).filter(Boolean);
}

function matchesSimple(node, selector) {
  let source = selector.trim();
  const rejected = [];
  source = source.replace(/:not\((\[[^)]+\])\)/g, (_all, inner) => {
    rejected.push(inner);
    return '';
  });
  if (rejected.some(inner => matchesSimple(node, inner))) return false;

  const tag = source.match(/^[a-z][a-z0-9-]*/i);
  if (tag && node.tagName.toLowerCase() !== tag[0].toLowerCase()) return false;

  for (const match of source.matchAll(/\.([a-z0-9_-]+)/gi)) {
    if (!String(node.getAttribute('class') || '').split(/\s+/).includes(match[1])) return false;
  }

  for (const match of source.matchAll(/\[([^\]\s~*^$|=]+)(?:\s*(\*=|=)\s*["']?([^\]"']*)["']?)?\]/g)) {
    const [, name, operator, expected] = match;
    const actual = node.getAttribute(name);
    if (actual == null) return false;
    if (operator === '=' && actual !== expected) return false;
    if (operator === '*=' && !actual.includes(expected)) return false;
  }
  return true;
}

class FakeText {
  constructor(value) {
    this.nodeValue = value;
    this.parentElement = null;
    this.parentNode = null;
  }
}

class FakeElement {
  constructor(tagName = 'div', attributes = {}, text = '') {
    this.tagName = tagName.toUpperCase();
    this.attributes = { ...attributes };
    this._text = text;
    this.childNodes = [];
    this.parentElement = null;
    this.parentNode = null;
    this.ownerDocument = null;
    this.isConnected = false;
    this.queries = [];
    this.clickCount = 0;
  }

  get id() { return this.getAttribute('id') || ''; }
  get textContent() {
    return this._text + this.childNodes.map(child =>
      child instanceof FakeText ? child.nodeValue : child.textContent).join('');
  }
  set textContent(value) { this._text = String(value); }

  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      child.parentNode = this;
      this.childNodes.push(child);
      if (this.ownerDocument) this.ownerDocument.connect(child);
    }
    return this;
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name)
      ? String(this.attributes[name])
      : null;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }

  matches(selector) {
    return splitSelectors(selector).some(part => matchesSimple(this, part));
  }

  descendants() {
    const found = [];
    const visit = node => {
      if (!(node instanceof FakeElement)) return;
      found.push(node);
      node.childNodes.forEach(visit);
    };
    this.childNodes.forEach(visit);
    return found;
  }

  querySelectorAll(selector) {
    this.queries.push(selector);
    return this.descendants().filter(node => node.matches(selector));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }

  closest(selector) {
    for (let node = this; node; node = node.parentElement) {
      if (node.matches(selector)) return node;
    }
    return null;
  }

  contains(other) {
    return other === this || this.descendants().includes(other);
  }

  click() { this.clickCount++; }
}

class FakeDocument {
  constructor(body = new FakeElement('body')) {
    this.body = body;
    this.title = 'Test call - Google Meet';
    this.readyState = 'complete';
    this.queries = [];
    this.connect(body);
  }

  connect(node) {
    if (node instanceof FakeElement) {
      node.ownerDocument = this;
      node.isConnected = true;
      node.childNodes.forEach(child => this.connect(child));
    }
  }

  allElements() { return [this.body, ...this.body.descendants()]; }
  querySelectorAll(selector) {
    this.queries.push(selector);
    return this.allElements().filter(node => node.matches(selector));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getElementById(id) { return this.allElements().find(node => node.id === id) || null; }
  addEventListener() {}

  createTreeWalker(root) {
    const texts = [];
    const visit = node => {
      if (node instanceof FakeText) texts.push(node);
      else if (node instanceof FakeElement) node.childNodes.forEach(visit);
    };
    visit(root);
    let index = -1;
    return { nextNode: () => texts[++index] || null };
  }
}

const el = (tag, attributes = {}, text = '') => new FakeElement(tag, attributes, text);
const text = value => new FakeText(value);

class FixedDate extends Date {
  constructor(...args) {
    super(...(args.length ? args : ['2026-08-16T10:30:00+02:00']));
  }
  static now() { return Date.parse('2026-08-16T10:30:00+02:00'); }
}

async function loadHarness({ body = el('body'), autoTrack = true, autoTrackReadError = null } = {}) {
  const original = await readFile(SOURCE_PATH, 'utf8');
  const hook = `  window.__attendanceTest = {
    accessibleName: typeof accessibleName === 'function' ? accessibleName : null,
    findParticipantPanelButton,
    resolveParticipantPanel: typeof resolveParticipantPanel === 'function' ? resolveParticipantPanel : null,
    scanParticipantPanel: typeof scanParticipantPanel === 'function' ? scanParticipantPanel : null,
    parseTimeRange,
    isTrustedScheduleNode: typeof isTrustedScheduleNode === 'function' ? isTrustedScheduleNode : null,
    detectScheduledWindow,
    scanParticipants,
    watchAutoTrack,
    startTracking,
    watchdogTick: typeof watchdogTick === 'function' ? watchdogTick : null,
    setState(next) {
      if ('tracking' in next) isTracking = next.tracking;
      if ('meetingId' in next) currentMeetingId = next.meetingId;
      if ('stoppedMeetingId' in next) stoppedMeetingId = next.stoppedMeetingId;
      if ('participants' in next) participants = next.participants;
      if ('autoTrack' in next) autoTrack = next.autoTrack;
    },
    getState() { return { isTracking, currentMeetingId, stoppedMeetingId, participants, autoTrack }; }
  };`;
  const source = original.replace(/  init\(\);\r?\n\}\)\(\);\s*$/, `${hook}\n})();`);
  assert.notEqual(source, original, 'the harness must replace only the final init call');

  const document = new FakeDocument(body);
  const sent = [];
  const warnings = [];
  const intervalCallbacks = [];
  const runtimeListeners = [];
  const storageListeners = [];
  const window = {
    location: { pathname: '/abc-defg-hij', href: 'https://meet.google.com/abc-defg-hij' },
    addEventListener() {}
  };
  const chrome = {
    runtime: {
      id: 'test-extension',
      lastError: null,
      sendMessage(message) { sent.push(message); return Promise.resolve({}); },
      onMessage: {
        addListener(listener) { runtimeListeners.push(listener); },
        removeListener(listener) {
          const index = runtimeListeners.indexOf(listener);
          if (index >= 0) runtimeListeners.splice(index, 1);
        }
      }
    },
    storage: {
      local: {
        get(_keys, callback) {
          chrome.runtime.lastError = autoTrackReadError
            ? { message: autoTrackReadError }
            : null;
          callback(autoTrackReadError ? undefined : { autoTrack });
          chrome.runtime.lastError = null;
        }
      },
      onChanged: {
        addListener(listener) { storageListeners.push(listener); },
        removeListener(listener) {
          const index = storageListeners.indexOf(listener);
          if (index >= 0) storageListeners.splice(index, 1);
        }
      }
    }
  };
  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; }
    observe() {}
    disconnect() {}
  }
  const context = vm.createContext({
    window, document, chrome, Date: FixedDate,
    NodeFilter: { SHOW_TEXT: 4 }, MutationObserver: FakeMutationObserver,
    setTimeout: () => 1, clearTimeout: () => {},
    setInterval(callback) { intervalCallbacks.push(callback); return intervalCallbacks.length; },
    clearInterval: () => {},
    console: { log() {}, warn(...args) { warnings.push(args.join(' ')); }, error() {} }
  });
  vm.runInContext(source, context, { filename: 'content-script.js' });
  return { hooks: window.__attendanceTest, document, window, sent, warnings, intervalCallbacks };
}

for (const label of ['People', 'Osoby', '사용자']) {
  for (const kind of ['native', 'role']) {
    test(`${kind} people control is found with the ${label} label`, async () => {
      const attributes = kind === 'role' ? { role: 'button', 'aria-label': label } : { 'aria-label': label };
      const button = el(kind === 'role' ? 'div' : 'button', attributes);
      const { hooks } = await loadHarness({ body: el('body').append(button) });

      assert.equal(hooks.findParticipantPanelButton(), button);
    });
  }
}

test('accessible name combines every aria-labelledby reference', async () => {
  const first = el('span', { id: 'label-a' }, '  People ');
  const second = el('span', { id: 'label-b' }, ' panel  ');
  const button = el('button', { 'aria-labelledby': 'label-a label-b' });
  const { hooks } = await loadHarness({ body: el('body').append(first, second, button) });

  assert.equal(hooks.accessibleName(button), 'People panel');
});

test('participant scanning stays below the resolved panel root', async () => {
  const button = el('button', { 'aria-label': 'People' });
  const list = el('div', { role: 'list' }).append(
    el('div', { role: 'listitem', 'aria-label': 'Alice' })
  );
  const panel = el('section', { 'data-panel-id': '5' }).append(list);
  const unrelated = el('div', { role: 'listitem', 'aria-label': 'Chat message' });
  const { hooks } = await loadHarness({ body: el('body').append(button, panel, unrelated) });

  const snapshot = hooks.scanParticipantPanel();

  assert.deepEqual(Array.from(snapshot.people, person => person.name), ['Alice']);
  assert.equal(snapshot.authoritative, true);
});

test('an unrelated Meet control with panel id 5 does not hide the participant list', async () => {
  const meetingDetails = el('button', {
    'aria-label': 'Meeting details',
    'aria-controls': 'ME4pNd',
    'data-panel-id': '5'
  });
  const peopleButton = el('div', { role: 'button', 'aria-label': 'Osoby' });
  const participantList = el('div', { role: 'list', 'aria-label': 'Uczestnicy' }).append(
    el('div', { role: 'listitem', 'aria-label': 'Krzysztof Mizgala' })
  );
  const { hooks } = await loadHarness({
    body: el('body').append(meetingDetails, peopleButton, participantList)
  });

  assert.equal(hooks.resolveParticipantPanel(peopleButton), participantList);
  const snapshot = hooks.scanParticipantPanel();
  assert.deepEqual(Array.from(snapshot.people, person => person.name), ['Krzysztof Mizgala']);
  assert.equal(snapshot.authoritative, true);
});

test('aria-controls resolves a participant panel without a fixed panel id', async () => {
  const button = el('div', { role: 'button', 'aria-label': 'Osoby', 'aria-controls': 'people-drawer' });
  const panel = el('section', { id: 'people-drawer', role: 'dialog' }).append(
    el('div', { role: 'list' }).append(el('div', { role: 'listitem', 'aria-label': 'Alicja' }))
  );
  const { hooks } = await loadHarness({ body: el('body').append(button, panel) });

  assert.equal(hooks.resolveParticipantPanel(button), panel);
  assert.deepEqual(Array.from(hooks.scanParticipantPanel().people, person => person.name), ['Alicja']);
});

test('an accessible panel label is the last-resort panel link', async () => {
  const panel = el('section', { 'aria-label': 'Participants' }).append(
    el('div', { role: 'list' }).append(el('div', { role: 'listitem', 'aria-label': 'Alice' }))
  );
  const { hooks } = await loadHarness({ body: el('body').append(panel) });

  assert.equal(hooks.resolveParticipantPanel(null), panel);
});

test('a loose participant card is observable but not an authoritative list', async () => {
  const panel = el('section', { 'data-panel-id': '5' }).append(
    el('div', { role: 'listitem', 'aria-label': 'Alice' })
  );
  const { hooks } = await loadHarness({ body: el('body').append(panel) });

  const snapshot = hooks.scanParticipantPanel();

  assert.deepEqual(Array.from(snapshot.people, person => person.name), ['Alice']);
  assert.equal(snapshot.authoritative, false);
});

test('a virtualized participant list cannot report departures', async () => {
  const list = el('div', { role: 'list' }).append(
    el('div', { role: 'listitem', 'aria-label': 'Alice', 'aria-posinset': '1', 'aria-setsize': '20' }),
    el('div', { role: 'listitem', 'aria-label': 'Charlie', 'aria-posinset': '2', 'aria-setsize': '20' })
  );
  const panel = el('section', { 'data-panel-id': '5', 'data-virtualized': 'true' }).append(list);
  const { hooks, sent } = await loadHarness({ body: el('body').append(panel) });
  hooks.setState({
    tracking: true,
    meetingId: 'abc-defg-hij',
    participants: {
      Alice: { name: 'Alice', events: [], isPresent: true },
      Bob: { name: 'Bob', events: [], isPresent: true }
    }
  });

  hooks.scanParticipants();
  assert.equal(hooks.getState().participants.Bob.isPresent, true);
  assert.equal(hooks.getState().participants.Charlie.isPresent, true);
  assert.equal(sent.some(message => message.action === 'participantLeft'), false);

  panel.removeAttribute('data-virtualized');
  list.childNodes.forEach(item => {
    item.removeAttribute('aria-posinset');
    item.removeAttribute('aria-setsize');
  });
  hooks.scanParticipants();
  assert.equal(hooks.getState().participants.Bob.isPresent, false);
  assert.equal(sent.some(message => message.action === 'participantLeft' && message.data.name === 'Bob'), true);
});

test('time range parsing accepts only the complete text', async () => {
  const { hooks } = await loadHarness();

  assert.ok(hooks.parseTimeRange('10:00 - 11:00'));
  assert.equal(hooks.parseTimeRange('chat: 10:00 - 11:00 now'), null);
});

test('only a trusted event heading supplies scheduled hours', async () => {
  const body = el('body');
  body.append(
    el('div', { role: 'log' }).append(text('09:00 - 10:00')),
    el('div', { 'aria-live': 'polite' }).append(text('09:00 - 10:00')),
    el('div', { contenteditable: 'true' }).append(text('09:00 - 10:00')),
    el('button').append(text('09:00 - 10:00')),
    el('section', { 'data-panel-id': '5' }).append(
      el('div', { role: 'listitem' }).append(text('09:00 - 10:00'))
    ),
    el('div').append(text('09:00 - 10:00')),
    el('h2').append(text('10:00 - 11:00'))
  );
  const { hooks } = await loadHarness({ body });

  const scheduled = hooks.detectScheduledWindow();

  assert.ok(scheduled);
  assert.equal(new Date(scheduled.start).getHours(), 10);
  assert.equal(new Date(scheduled.end).getHours(), 11);
});

test('disabling automatic tracking keeps the current call and blocks the next one', async () => {
  const controls = el('button', { 'data-is-muted': 'false' });
  const { hooks, window, sent } = await loadHarness({ body: el('body').append(controls) });
  hooks.setState({ tracking: true, meetingId: 'abc-defg-hij', autoTrack: true });

  hooks.watchAutoTrack({ autoTrack: { newValue: false } }, 'local');

  assert.equal(hooks.getState().isTracking, true);
  assert.equal(sent.some(message => message.type === 'MEETING_ENDED'), false);

  hooks.setState({ tracking: false, meetingId: null, stoppedMeetingId: 'abc-defg-hij' });
  window.location.pathname = '/new-call-abc';
  window.location.href = 'https://meet.google.com/new-call-abc';
  hooks.watchdogTick();

  assert.equal(sent.some(message => message.type === 'MEETING_STARTED'), false);
});

test('a failed auto-track preference read cannot opt the user into tracking', async () => {
  const controls = el('button', { 'data-is-muted': 'false' });
  const { hooks, sent, warnings } = await loadHarness({
    body: el('body').append(controls),
    autoTrackReadError: 'storage unavailable'
  });

  assert.equal(hooks.getState().autoTrack, null);
  hooks.watchdogTick();
  assert.equal(sent.some(message => message.type === 'MEETING_STARTED'), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /storage unavailable/);
});
