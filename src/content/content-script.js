/**
 * Google Meet Attendance Tracker - Content Script
 * Detects participants in Google Meet and tracks their join/leave times
 */

(function() {
  'use strict';

  // State
  let currentMeetingId = null;
  let participants = {};
  let observer = null;
  let pollingInterval = null;
  let isTracking = false;
  let scheduledWindow = null;   // { start, end } ISO, scraped from the calendar event
  let scheduleAttempts = 0;

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

  function openParticipantPanelOnce() {
    const panelBtn = findParticipantPanelButton();

    if (panelBtn) {
      console.log('[Attendance] Auto-opening participant panel to initialize DOM');
      panelBtn.click();

      // Wait until participant elements actually appear in DOM
      let attempts = 0;
      const waitForDOM = setInterval(() => {
        attempts++;
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
    } else {
      console.log('[Attendance] Participant panel button not found, retrying...');
      setTimeout(openParticipantPanelOnce, 2000);
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
    chrome.runtime.sendMessage({
      type: 'MEETING_SCHEDULE',
      meetingId: currentMeetingId,
      url: window.location.href,
      meetingTitle: getMeetingTitle(),
      scheduledStart: scheduledWindow.start,
      scheduledEnd: scheduledWindow.end
    }).catch(err => {
      console.warn('[Attendance] Failed to report scheduled hours:', err);
    });
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

    // Validate name
    if (!name || name.length < 1 || name.length > 100) {
      return null;
    }

    // Filter out internal IDs (not real participant names)
    if (name.startsWith('spaces/') ||
        name.startsWith('devices/') ||
        name.match(/^[a-zA-Z0-9_-]{20,}$/) ||
        name.includes('/devices/') ||
        name.includes('/participants/')) {
      return null;
    }

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
        const selfName = selfElement.getAttribute('data-self-name') ||
                         selfElement.textContent.trim();
        if (selfName && !participants[selfName]) {
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
    chrome.runtime.sendMessage({
      type: 'ATTENDANCE_UPDATE',
      action: action,
      meetingId: currentMeetingId,
      data: data,
      participants: participants,
      timestamp: new Date().toISOString()
    }).catch(err => {
      console.warn('[Attendance] Failed to notify background:', err);
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
   * Start tracking attendance
   */
  function startTracking() {
    currentMeetingId = getMeetingId();
    if (!currentMeetingId) {
      console.log('[Attendance] Not in a meeting, waiting...');
      setTimeout(startTracking, 2000);
      return;
    }

    // Respect the auto-track setting (default on). If disabled, stay idle.
    chrome.storage.local.get(['autoTrack'], (res) => {
      if (res && res.autoTrack === false) {
        console.log('[Attendance] Auto-track disabled — not tracking this meeting');
        return;
      }
      beginTracking();
    });
  }

  function beginTracking() {
    console.log('[Attendance] Starting tracking for meeting:', currentMeetingId);
    isTracking = true;
    participants = {};
    scheduledWindow = null;
    scheduleAttempts = 0;

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

    // Notify background that tracking started
    chrome.runtime.sendMessage({
      type: 'MEETING_STARTED',
      meetingId: currentMeetingId,
      startTime: new Date().toISOString(),
      url: window.location.href,
      meetingTitle: getMeetingTitle()
    }).catch(err => {
      console.warn('[Attendance] Failed to notify meeting start:', err);
    });

    // Read the event's scheduled hours while they may still be on screen
    pollScheduledWindow();
  }

  /**
   * Stop tracking attendance
   */
  function stopTracking() {
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
    chrome.runtime.sendMessage({
      type: 'MEETING_ENDED',
      meetingId: currentMeetingId,
      endTime: endTime,
      participants: participants
    }).catch(err => {
      console.warn('[Attendance] Failed to notify meeting end:', err);
    });

    currentMeetingId = null;
    participants = {};
  }

  /**
   * Handle messages from popup or background
   */
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
  });

  /**
   * Detect when user leaves the meeting
   */
  function detectMeetingEnd() {
    // Method 1: Check if URL no longer contains a meeting ID
    const currentUrlMeetingId = getMeetingId();
    if (!currentUrlMeetingId && currentMeetingId) {
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

    // Wait for page to be ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        setTimeout(startTracking, 2000);
      });
    } else {
      setTimeout(startTracking, 2000);
    }

    // Monitor for meeting end
    setInterval(() => {
      if (isTracking) {
        detectMeetingEnd();
      }
    }, 3000);

    // Handle page unload
    window.addEventListener('beforeunload', () => {
      if (isTracking) {
        stopTracking();
      }
    });
  }

  init();
})();
