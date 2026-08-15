/**
 * Google Meet Attendance Tracker - Content Script
 * Detects participants in Google Meet and tracks their join/leave times
 *
 * Two copies of this can meet in one page. Reloading, updating or switching the extension off
 * leaves the copy that is here running but cut off — chrome.runtime is gone and every send throws
 * — and the worker injects a fresh copy into tabs that are already open, because that is the only
 * way a call in progress gets picked back up. So the first thing a copy does is stand the previous
 * one down, and every copy watches for the moment it is the one that has been cut off.
 */

(function() {
  'use strict';

  // Whoever arrives last is the one that still has a working connection: shut the other down
  // before taking over. Quietly — the call is still running, and the record stays open for us.
  if (typeof window.__gmAttendanceStop === 'function') window.__gmAttendanceStop();

  // State
  let currentMeetingId = null;
  let participants = {};
  let observer = null;
  let pollingInterval = null;
  let watchdogInterval = null;
  let heartbeatInterval = null;
  let isTracking = false;
  let scheduledWindow = null;   // { start, end } ISO, scraped from the calendar event
  let scheduleAttempts = 0;
  let stoppedMeetingId = null;  // the call already finished at this URL — don't start it again
  let panelAttempts = 0;

  /**
   * How often to tell the worker this page is still on the call. Nothing else says so: a call
   * where nobody comes or goes records no events for an hour, and a meeting the browser was
   * closed on can only be ended where it was last known to be running. A minute apart leaves
   * the worker free to sleep in between.
   */
  const HEARTBEAT_MS = 60000;

  /**
   * Is the extension still behind us? A reload, an update or a switch-off leaves this script in
   * the page with nothing at the other end: chrome.runtime.id goes away, and sending throws
   * rather than rejecting, so a bare .catch() would not hold it.
   */
  function isExtensionAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  /** Send to the worker, or notice there is nobody left to send to and stand down. */
  function send(message) {
    if (!isExtensionAlive()) { teardown(); return Promise.resolve(null); }
    try {
      return chrome.runtime.sendMessage(message).catch(() => null);
    } catch (e) {
      teardown();
      return Promise.resolve(null);
    }
  }

  /**
   * Stop working without reporting an end. The call is still running; it is this script that is
   * going away, so the meeting is left open for whichever copy takes over to resume.
   */
  function teardown() {
    isTracking = false;
    if (observer) { observer.disconnect(); observer = null; }
    clearInterval(pollingInterval); pollingInterval = null;
    clearInterval(watchdogInterval); watchdogInterval = null;
    clearInterval(heartbeatInterval); heartbeatInterval = null;
    clearTimeout(window._attendanceDebounce);
    // Listeners too, or a copy that has stood down still answers the popup asking who is here.
    try {
      chrome.runtime.onMessage.removeListener(handleRuntimeMessage);
      chrome.storage.onChanged.removeListener(watchAutoTrack);
    } catch (e) { /* the extension is already gone; the listeners went with it */ }
    if (window.__gmAttendanceStop === teardown) delete window.__gmAttendanceStop;
  }

  // Mirrors the stored setting; null until it has been read, so nothing starts on a guess.
  let autoTrack = null;
  chrome.storage.local.get(['autoTrack'], (res) => {
    autoTrack = !(res && res.autoTrack === false);
    if (!autoTrack) console.log('[Attendance] Auto-track disabled — not tracking');
  });
  function watchAutoTrack(changes, area) {
    if (area === 'local' && changes.autoTrack) autoTrack = changes.autoTrack.newValue !== false;
  }
  chrome.storage.onChanged.addListener(watchAutoTrack);

  // Multiple selectors for participant detection (Google Meet DOM changes frequently)
  const PARTICIPANT_SELECTORS = [
    'div[role="listitem"][aria-label]',  // Most reliable - participant list item with name in aria-label
    '.KV1GEc',  // Participant container
    '[data-self-name]'
  ];

  // Selectors for participant panel (includes Korean locale support)
  const PANEL_SELECTORS = [
    '[aria-label*="participant"]',
    '[aria-label*="참가자"]',
    '.VfPpkd-Bz112c-LgbsSe',
    '[data-panel-id="5"]',  // People panel
    '.TNczGb'  // Panel container
  ];

  /**
   * Auto-open participant panel once to initialize DOM elements, then close it
   */
  function findParticipantPanelButton() {
    // The participant button is a div[role="button"] labeled via aria-labelledby
    // Find by checking the label text for "사용자" (Korean) or "People" (English)
    const buttons = document.querySelectorAll('div[role="button"][aria-labelledby]');
    for (const btn of buttons) {
      const labelId = btn.getAttribute('aria-labelledby');
      if (labelId) {
        const labelEl = document.getElementById(labelId);
        if (labelEl) {
          const text = labelEl.textContent.trim();
          if (text === '사용자' || text === 'People' || text === 'Participants') {
            return btn;
          }
        }
      }
    }
    return null;
  }

  // ~30s of retries. Meet's controls are up long before that, and a page that never shows them
  // is not one we are going to read — retrying for the life of the tab only burns cycles.
  const PANEL_MAX_ATTEMPTS = 15;

  function openParticipantPanelOnce() {
    if (!isTracking) return;   // the call ended while we were waiting for the button
    const panelBtn = findParticipantPanelButton();

    if (panelBtn) {
      console.log('[Attendance] Auto-opening participant panel to initialize DOM');
      panelBtn.click();

      // Wait until participant elements actually appear in DOM
      let attempts = 0;
      const waitForDOM = setInterval(() => {
        attempts++;
        if (!isTracking) { clearInterval(waitForDOM); return; }
        const found = document.querySelector('div[role="listitem"][aria-label], .KV1GEc');
        console.log('[Attendance] Waiting for participant DOM... attempt', attempts, 'found:', !!found);

        if (found) {
          clearInterval(waitForDOM);
          // Scan FIRST while panel is still open
          scanParticipants();
          // Then close the panel
          setTimeout(() => {
            panelBtn.click();
            console.log('[Attendance] Participant panel closed');
          }, 500);
        } else if (attempts >= 30) {
          clearInterval(waitForDOM);
          panelBtn.click();
          console.log('[Attendance] Timeout waiting for participant DOM');
        }
      }, 500);
    } else if (++panelAttempts < PANEL_MAX_ATTEMPTS) {
      console.log('[Attendance] Participant panel button not found, retrying...');
      setTimeout(openParticipantPanelOnce, 2000);
    } else {
      console.log('[Attendance] Participant panel button not found, giving up');
    }
  }

  /**
   * Extract meeting ID from URL
   */
  function getMeetingId() {
    const match = window.location.pathname.match(/\/([a-z]{3}-[a-z]{4}-[a-z]{3})/);
    return match ? match[1] : null;
  }

  /**
   * Meet saying the call at this address is already over.
   *
   * Leaving a call keeps its code in the address bar, so the URL alone cannot tell a call in
   * progress from the screen you land on when you leave one. It matters because this script is
   * also put into tabs that were open long before it arrived (see the worker's ensureTrackers):
   * without asking, a tab still showing "you left the meeting" would open a record for a call
   * that finished hours ago, and then close it again at the wrong hour.
   */
  function callHasEnded() {
    return !!(document.querySelector('[data-call-ended="true"]') ||
              document.querySelector('[data-mdc-dialog-action="returnToHomePage"]'));
  }

  /**
   * Derive a friendly meeting title from the tab title, falling back to the code.
   * Google Meet titles look like "Meet – abc-defg-hij" or a Calendar event name.
   */
  function getMeetingTitle() {
    let t = (document.title || '').trim();
    t = t.replace(/\s*[-–—|]\s*Google Meet\s*$/i, '')
         .replace(/^Meet\s*[-–—|]\s*/i, '')
         .replace(/^Google Meet\s*[-–—|]?\s*/i, '')
         .trim();
    const code = getMeetingId();
    if (!t || /^meet$/i.test(t)) return code || 'Meeting';
    return t;
  }

  /**
   * Scheduled hours of the calendar event, as Meet prints them ("10:00 – 11:00").
   *
   * Worth scraping because the tracked start time is merely when the tab was opened —
   * joining early would otherwise stretch the meeting past its real hours. Best-effort
   * only: heavily validated, never overwrites a value the user set, and the dashboard
   * always allows fixing the hours by hand.
   */
  const CLOCK = String.raw`(\d{1,2})[:.](\d{2})\s*(a\.?m\.?|p\.?m\.?)?`;
  const TIME_RANGE_RE = new RegExp(CLOCK + String.raw`\s*[–—−-]\s*` + CLOCK, 'i');

  function to24h(hour, meridiem) {
    const h = Number(hour);
    if (!meridiem) return h;
    if (/^p/i.test(meridiem)) return h < 12 ? h + 12 : h;
    return h === 12 ? 0 : h;
  }

  /**
   * The 24h readings one side could stand for. A side that carries its own am/pm is
   * fixed; a bare side is literal on a 24h clock, but ambiguous once the other side
   * proves the range is written on a 12h one ("11:00 – 12:30 pm" starts at 11am).
   */
  function hourCandidates(hour, meridiem, anyMeridiem) {
    if (meridiem) return [to24h(hour, meridiem)];
    if (!anyMeridiem) return [Number(hour)];
    return [to24h(hour, 'am'), to24h(hour, 'pm')];
  }

  /** Parse "10:00 – 11:00" (optionally am/pm) into today's ISO window, or null. */
  function parseTimeRange(text) {
    const m = TIME_RANGE_RE.exec(text);
    if (!m) return null;

    const startMin = Number(m[2]), endMin = Number(m[5]);
    if (startMin > 59 || endMin > 59) return null;

    const anyMeridiem = !!(m[3] || m[6]);
    const now = new Date();
    let best = null;

    for (const startH of hourCandidates(m[1], m[3], anyMeridiem)) {
      for (const endH of hourCandidates(m[4], m[6], anyMeridiem)) {
        if (startH > 23 || endH > 23) continue;

        const start = new Date(now); start.setHours(startH, startMin, 0, 0);
        const end = new Date(now); end.setHours(endH, endMin, 0, 0);

        const minutes = (end - start) / 60000;
        if (minutes <= 0 || minutes > 12 * 60) continue;          // not a sane meeting length
        if (Math.abs(start - now) > 6 * 60 * 60 * 1000) continue; // not the event we're in

        if (!best || minutes < best.minutes) best = { start, end, minutes };
      }
    }
    return best ? { start: best.start.toISOString(), end: best.end.toISOString() } : null;
  }

  /** Look for a short text node that is just a time range (event header, green room). */
  function detectScheduledWindow() {
    if (!document.body) return null;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.nodeValue || '').trim();
      if (text.length < 9 || text.length > 48) continue;
      const win = parseTimeRange(text);
      if (win) return win;
    }
    return null;
  }

  /** Poll for the event time while it may still be on screen (green room, event header). */
  function pollScheduledWindow() {
    if (!isTracking || scheduledWindow || scheduleAttempts >= 8) return;
    scheduleAttempts++;

    scheduledWindow = detectScheduledWindow();
    if (!scheduledWindow) { setTimeout(pollScheduledWindow, 2000); return; }

    console.log('[Attendance] Scheduled hours detected:', scheduledWindow.start, '→', scheduledWindow.end);
    send({
      type: 'MEETING_SCHEDULE',
      meetingId: currentMeetingId,
      url: window.location.href,
      meetingTitle: getMeetingTitle(),
      scheduledStart: scheduledWindow.start,
      scheduledEnd: scheduledWindow.end
    });
  }

  /**
   * Is this a plausible participant name, or DOM noise? Meet's markup carries internal ids
   * next to the names, and a container we read by mistake hands back its whole text — either
   * one would be stored as a person and follow the meeting into every export.
   */
  function isValidName(name) {
    if (!name || name.length < 1 || name.length > 100) return false;
    return !(name.startsWith('spaces/') ||
             name.startsWith('devices/') ||
             /^[a-zA-Z0-9_-]{20,}$/.test(name) ||
             name.includes('/devices/') ||
             name.includes('/participants/'));
  }

  /**
   * Extract participant info from DOM element
   */
  function extractParticipantInfo(element) {
    let name = null;
    let email = null;

    // Method 1: aria-label on listitem (most reliable for current Meet UI)
    // e.g., <div role="listitem" aria-label="kyno" ...>
    const ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel && !ariaLabel.includes('spaces/') && !ariaLabel.includes('devices/')) {
      name = ariaLabel.trim();
    }

    // Method 2: Look for .zWGUib inside the element (participant name span)
    if (!name) {
      const nameElement = element.querySelector('.zWGUib') ||
                          element.querySelector('[data-self-name]') ||
                          element.querySelector('.XEazBc') ||
                          element.querySelector('.ZjFb7c') ||
                          element.querySelector('.cS7aqe');
      if (nameElement) {
        name = nameElement.textContent.trim();
      }
    }

    // Method 3: data-self-name attribute (for self/current user)
    if (!name) {
      const selfName = element.getAttribute('data-self-name');
      if (selfName) {
        name = selfName.trim();
      }
    }

    // Try to extract email if visible (usually only for same organization)
    const emailElement = element.querySelector('[data-email]') ||
                         element.querySelector('.jxFHg');
    if (emailElement) {
      email = emailElement.getAttribute('data-email') ||
              emailElement.textContent.trim();
    }

    if (!isValidName(name)) return null;

    return { name, email };
  }

  /**
   * Scan for participants in the DOM
   */
  function scanParticipants() {
    if (!isTracking) return;

    const currentTime = new Date().toISOString();
    const foundParticipants = new Set();

    // Try each selector
    for (const selector of PARTICIPANT_SELECTORS) {
      try {
        const elements = document.querySelectorAll(selector);
        elements.forEach(element => {
          const info = extractParticipantInfo(element);
          if (info && info.name) {
            foundParticipants.add(info.name);

            // New participant
            if (!participants[info.name]) {
              participants[info.name] = {
                name: info.name,
                email: info.email || null,
                events: [{ time: currentTime, type: 'Join' }],
                isPresent: true
              };
              console.log('[Attendance] Participant joined:', info.name);
              notifyBackground('participantJoined', participants[info.name]);
            }
            // Update email if newly available
            else if (info.email && !participants[info.name].email) {
              participants[info.name].email = info.email;
            }
            // Rejoined after leaving
            else if (!participants[info.name].isPresent) {
              participants[info.name].events.push({ time: currentTime, type: 'Join' });
              participants[info.name].isPresent = true;
              console.log('[Attendance] Participant rejoined:', info.name);
              notifyBackground('participantRejoined', participants[info.name]);
            }
          }
        });
      } catch (e) {
        console.warn('[Attendance] Selector failed:', selector, e);
      }
    }

    // Check for participants who left
    for (const name in participants) {
      if (!foundParticipants.has(name) && participants[name].isPresent) {
        participants[name].events.push({ time: currentTime, type: 'Leave' });
        participants[name].isPresent = false;
        console.log('[Attendance] Participant left:', name);
        notifyBackground('participantLeft', participants[name]);
      }
    }

    // Also try to detect self (the current user)
    detectSelf();
  }

  /**
   * Detect the current user (self)
   */
  function detectSelf() {
    const selfSelectors = [
      '[data-self-name]',
      '[data-is-self="true"]',
      '.uGOf1d[data-self-name]'
    ];

    for (const selector of selfSelectors) {
      const selfElement = document.querySelector(selector);
      if (selfElement) {
        const selfName = (selfElement.getAttribute('data-self-name') ||
                          selfElement.textContent || '').trim();
        if (isValidName(selfName) && !participants[selfName]) {
          participants[selfName] = {
            name: selfName,
            email: null,
            events: [{ time: new Date().toISOString(), type: 'Join' }],
            isPresent: true,
            isSelf: true
          };
          notifyBackground('participantJoined', participants[selfName]);
        }
        break;
      }
    }
  }

  /**
   * Send message to background service worker
   */
  function notifyBackground(action, data) {
    send({
      type: 'ATTENDANCE_UPDATE',
      action: action,
      meetingId: currentMeetingId,
      data: data,
      participants: participants,
      timestamp: new Date().toISOString()
    });
  }

  /** Tell the worker the page is still on the call, so a recovery knows how far it got. */
  function sendHeartbeat() {
    if (!isTracking) return;
    send({
      type: 'MEETING_HEARTBEAT',
      meetingId: currentMeetingId,
      url: window.location.href,
      meetingTitle: getMeetingTitle(),
      at: new Date().toISOString()
    });
  }

  /**
   * Set up MutationObserver for real-time participant tracking
   */
  function setupObserver() {
    if (observer) {
      observer.disconnect();
    }

    observer = new MutationObserver((mutations) => {
      // Debounce rapid changes
      clearTimeout(window._attendanceDebounce);
      window._attendanceDebounce = setTimeout(scanParticipants, 500);
    });

    // Observe the entire body for changes (participant panel may not exist initially)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-participant-id', 'data-requested-participant-id', 'aria-label']
    });

    console.log('[Attendance] MutationObserver set up');
  }

  /**
   * Start tracking the call this page is on, if there is one and auto-tracking is on.
   *
   * Idempotent and cheap, because the watchdog calls it every few seconds while idle: that is
   * what picks up a second meeting joined in the same tab, which Meet enters without a page
   * load. A call already finished at this URL is not started again — leaving a meeting keeps
   * its code in the address bar, and re-entering it would record everyone as joining twice.
   */
  function startTracking() {
    if (isTracking || autoTrack !== true) return;
    const id = getMeetingId();
    if (!id || id === stoppedMeetingId || callHasEnded()) return;
    currentMeetingId = id;
    beginTracking();
  }

  function beginTracking() {
    console.log('[Attendance] Starting tracking for meeting:', currentMeetingId);
    isTracking = true;
    participants = {};
    scheduledWindow = null;
    scheduleAttempts = 0;
    panelAttempts = 0;

    // Say what call this is before anything is reported into it. Whichever message reaches the
    // worker first is the one that opens the record, and only this one carries the title and the
    // link — a scan that got there first would leave the meeting named after its bare code.
    send({
      type: 'MEETING_STARTED',
      meetingId: currentMeetingId,
      startTime: new Date().toISOString(),
      url: window.location.href,
      meetingTitle: getMeetingTitle()
    });
    if (!isTracking) return;   // there was nobody left to send to: teardown has already run

    // Auto-open participant panel to initialize DOM, then close it
    openParticipantPanelOnce();

    // Initial scan
    scanParticipants();

    // Set up observer
    setupObserver();

    // Polling backup (every 5 seconds)
    if (pollingInterval) {
      clearInterval(pollingInterval);
    }
    pollingInterval = setInterval(scanParticipants, 5000);

    // Read the event's scheduled hours while they may still be on screen
    pollScheduledWindow();
  }

  /**
   * Stop tracking attendance.
   *
   * `reason` says whether the call is over ('left') or this page is going away with the call
   * still running ('unload'), which the worker needs because the second one comes back: a
   * reload ends the record here and resumes it a moment later.
   */
  function stopTracking(reason = 'left') {
    console.log('[Attendance] Stopping tracking');
    isTracking = false;

    if (observer) {
      observer.disconnect();
      observer = null;
    }

    if (pollingInterval) {
      clearInterval(pollingInterval);
      pollingInterval = null;
    }

    // Mark all remaining participants as left
    const endTime = new Date().toISOString();
    for (const name in participants) {
      if (participants[name].isPresent) {
        participants[name].events.push({ time: endTime, type: 'Leave' });
        participants[name].isPresent = false;
      }
    }

    // Notify background that meeting ended
    send({
      type: 'MEETING_ENDED',
      meetingId: currentMeetingId,
      endTime: endTime,
      participants: participants,
      reason: reason
    });

    stoppedMeetingId = currentMeetingId;
    currentMeetingId = null;
    participants = {};
  }

  /**
   * Handle messages from popup or background. Answering at all is also how the worker tells a
   * tab that still has a working tracker from one whose tracker it has to put back.
   */
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);

  function handleRuntimeMessage(message, sender, sendResponse) {
    switch (message.type) {
      case 'GET_STATUS':
        sendResponse({
          isTracking: isTracking,
          meetingId: currentMeetingId,
          participants: participants,
          participantCount: Object.keys(participants).length
        });
        return true;

      case 'GET_PARTICIPANTS':
        sendResponse({
          meetingId: currentMeetingId,
          participants: participants
        });
        return true;

      case 'FORCE_SCAN':
        scanParticipants();
        sendResponse({ success: true, participants: participants });
        return true;

      case 'STOP_TRACKING':
        stopTracking();
        sendResponse({ success: true });
        return true;
    }
  }

  /**
   * Detect when user leaves the meeting
   */
  function detectMeetingEnd() {
    // Method 1: the address bar is no longer on the call being tracked — the home screen, or
    // another call entered without a page load, which is a second meeting and not this one.
    const currentUrlMeetingId = getMeetingId();
    if (currentMeetingId && currentUrlMeetingId !== currentMeetingId) {
      console.log('[Attendance] Meeting end detected: URL changed');
      stopTracking();
      return true;
    }

    // Method 2: Check for explicit "call ended" attribute
    if (document.querySelector('[data-call-ended="true"]')) {
      console.log('[Attendance] Meeting end detected: call-ended flag');
      stopTracking();
      return true;
    }

    // Method 3: Check for "Return to home screen" button (appears after leaving)
    // This button only appears when YOU left, not when others leave
    const returnHomeButton = document.querySelector('[data-mdc-dialog-action="returnToHomePage"]') ||
                             document.querySelector('button[jsname="EszDse"]');
    if (returnHomeButton) {
      console.log('[Attendance] Meeting end detected: return to home button');
      stopTracking();
      return true;
    }

    // Method 4: Check if video/audio controls are gone (meeting UI disappeared)
    const meetingControls = document.querySelector('[data-is-muted]') ||
                            document.querySelector('[aria-label*="microphone"]') ||
                            document.querySelector('[aria-label*="마이크"]');
    const hasMeetingId = getMeetingId();

    if (hasMeetingId && !meetingControls && isTracking) {
      // Wait a bit before confirming - UI might be loading
      if (!window._noControlsCount) window._noControlsCount = 0;
      window._noControlsCount++;

      if (window._noControlsCount > 3) {  // 9+ seconds without controls
        console.log('[Attendance] Meeting end detected: no meeting controls');
        stopTracking();
        window._noControlsCount = 0;
        return true;
      }
    } else {
      window._noControlsCount = 0;
    }

    return false;
  }

  /**
   * Initialize
   */
  function init() {
    console.log('[Attendance] Content script loaded');
    window.__gmAttendanceStop = teardown;

    // Wait for page to be ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        setTimeout(startTracking, 2000);
      });
    } else {
      setTimeout(startTracking, 2000);
    }

    // One watchdog for both ends of the meeting: it closes the call we are in, and picks up
    // the next one. Landing back on the home screen clears the finished call, so re-entering
    // the same link later starts a fresh session rather than being mistaken for it. It is also
    // where a copy that has been cut off from the extension finds out and stops.
    watchdogInterval = setInterval(() => {
      if (!isExtensionAlive()) { teardown(); return; }
      if (isTracking) { detectMeetingEnd(); return; }
      if (!getMeetingId()) stoppedMeetingId = null;
      else startTracking();
    }, 3000);

    heartbeatInterval = setInterval(sendHeartbeat, HEARTBEAT_MS);

    // Handle page unload — the page is going, the call is not: a reload picks the record
    // straight back up, so the worker is told which of the two this is.
    window.addEventListener('beforeunload', () => {
      if (isTracking) {
        stopTracking('unload');
      }
    });
  }

  init();
})();
