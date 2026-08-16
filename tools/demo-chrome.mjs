function clone(value) {
  return value == null ? value : structuredClone(value);
}
function createStorageArea(initial = {}) {
  const state = clone(initial) || {};

  return {
    get(keys, callback = () => {}) {
      let result = {};
      if (keys == null) result = clone(state);
      else if (typeof keys === 'string') {
        if (Object.hasOwn(state, keys)) result[keys] = clone(state[keys]);
      } else if (Array.isArray(keys)) {
        keys.forEach(key => {
          if (Object.hasOwn(state, key)) result[key] = clone(state[key]);
        });
      } else if (typeof keys === 'object') {
        Object.entries(keys).forEach(([key, fallback]) => {
          result[key] = Object.hasOwn(state, key) ? clone(state[key]) : clone(fallback);
        });
      }
      queueMicrotask(() => callback(result));
    },
    set(values, callback = () => {}) {
      Object.assign(state, clone(values));
      queueMicrotask(callback);
    },
    remove(keys, callback = () => {}) {
      (Array.isArray(keys) ? keys : [keys]).forEach(key => delete state[key]);
      queueMicrotask(callback);
    },
    clear(callback = () => {}) {
      Object.keys(state).forEach(key => delete state[key]);
      queueMicrotask(callback);
    }
  };
}

export function createChromeMock(demo, { origin = 'http://127.0.0.1:4177' } = {}) {
  const base = String(origin).replace(/\/$/, '');
  const local = createStorageArea({
    attendanceHistory: demo.history,
    meetingGroups: demo.groups,
    settings: demo.settings,
    savedRoster: demo.roster,
    schemaVersion: demo.schemaVersion,
    autoTrack: demo.autoTrack,
    analyticsFilters: { preset: '90d', from: '', to: '', groups: [], titles: [] }
  });
  const sync = createStorageArea({ rollcallLanguage: demo.language || 'pl' });

  const runtime = {
    lastError: null,
    getManifest: () => ({
      name: 'Google Meet Attendance Tracker',
      version: '1.3.1-demo',
      oauth2: { client_id: 'demo-client.apps.googleusercontent.com' }
    }),
    getURL: path => `${base}/${String(path || '').replace(/^\//, '')}`,
    openOptionsPage: async () => {}
  };

  return {
    storage: { local, sync },
    runtime,
    identity: {
      getAuthToken(_options, callback) {
        queueMicrotask(() => callback('demo-oauth-token'));
      },
      removeCachedAuthToken(_options, callback = () => {}) {
        queueMicrotask(callback);
      }
    },
    tabs: {
      query(_query, callback) {
        queueMicrotask(() => callback([{ id: 1, url: 'https://meet.google.com/aiw-prak-tyc' }]));
      },
      sendMessage(_tabId, _message, callback) {
        queueMicrotask(() => callback({
          isTracking: demo.live?.tracking !== false,
          participantCount: demo.live?.participantCount || 0
        }));
      },
      create({ url }, callback = () => {}) {
        queueMicrotask(() => callback({ id: 2, url }));
      }
    }
  };
}
