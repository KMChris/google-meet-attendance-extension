/** The day the whole pack is dated. Everything derived — meetings, ranges, stamps — hangs off it. */
export const DEMO_ANCHOR = '2026-08-14T10:00:00.000Z';

export const PROMO_SPECS = Object.freeze({
  small: Object.freeze({ width: 440, height: 280 }),
  marquee: Object.freeze({ width: 1400, height: 560 })
});

/**
 * Every frame the store pack is built from, in the order they are numbered on disk. `route` is the
 * dashboard hash the capture opens, `action` is whatever has to be clicked once it is there, and
 * `file` carries the name each language publishes under — the folders were named by hand long
 * before this was automated, and renaming them would break links already sent to the store.
 */
export const SCREENSHOT_SPECS = Object.freeze([
  { route: 'meetings', action: null, store: 1,
    file: { pl: '01-lista-spotkan.jpg', en: '01-meetings-list.jpg' },
    label: { pl: 'Lista spotkań', en: 'Meetings list' } },
  { route: 'meeting=demo-ai-04', action: null, store: 2,
    file: { pl: '02-szczegoly-spotkania-os-czasu.jpg', en: '02-meeting-presence-timeline.jpg' },
    label: { pl: 'Oś obecności', en: 'Presence timeline' } },
  { route: 'meeting=demo-ai-04', action: 'participant-modal',
    file: { pl: '03-edycja-uczestnika.jpg', en: '03-edit-participant.jpg' },
    label: { pl: 'Edycja i scalanie osoby', en: 'Editing and merging a person' } },
  { route: 'groups', action: null,
    file: { pl: '04-lista-cykli.jpg', en: '04-series-list.jpg' },
    label: { pl: 'Lista cykli', en: 'Series list' } },
  { route: 'group=grp-ai', action: null, store: 3,
    file: { pl: '05-macierz-frekwencji-cyklu.jpg', en: '05-series-attendance-matrix.jpg' },
    label: { pl: 'Macierz frekwencji cyklu', en: 'Series attendance matrix' } },
  { route: 'group=grp-ai&person=0', action: null,
    file: { pl: '06-osoba-w-cyklu.jpg', en: '06-person-in-series.jpg' },
    label: { pl: 'Historia osoby w cyklu', en: 'A person across the series' } },
  { route: 'people', action: null,
    file: { pl: '07-lista-osob.jpg', en: '07-people-list.jpg' },
    label: { pl: 'Zestawienie osób', en: 'People list' } },
  { route: 'people&person=0', action: null, store: 4,
    file: { pl: '08-historia-osoby.jpg', en: '08-person-history.jpg' },
    label: { pl: 'Historia spotkań osoby', en: 'One person’s meeting history' } },
  { route: 'analytics', action: null, store: 5,
    file: { pl: '09-analityka-wykresy.jpg', en: '09-analytics-charts.jpg' },
    label: { pl: 'Analityka i wykresy', en: 'Analytics and charts' } },
  { route: 'analytics', action: 'analytics-table',
    file: { pl: '10-analityka-tabela.jpg', en: '10-analytics-table.jpg' },
    label: { pl: 'Dane wykresu w tabeli', en: 'Chart data as a table' } },
  { route: 'settings', action: null,
    file: { pl: '11-ustawienia.jpg', en: '11-settings.jpg' },
    label: { pl: 'Ustawienia rozszerzenia', en: 'Extension settings' } },
  { route: 'settings', action: 'sheets-section',
    file: { pl: '12-google-sheets.jpg', en: '12-google-sheets.jpg' },
    label: { pl: 'Integracja z Google Sheets', en: 'Google Sheets integration' } },
  { route: 'popup', action: null, page: 'popup',
    file: { pl: '13-popup-rozszerzenia.jpg', en: '13-extension-popup.jpg' },
    label: { pl: 'Popup rozszerzenia', en: 'Extension popup' } },
  { route: 'meeting=demo-consult', action: null,
    file: { pl: '14-konsultacje-projektowe.jpg', en: '14-project-consultations.jpg' },
    label: { pl: 'Spotkanie poza cyklem', en: 'A meeting outside any series' } }
]);

/**
 * The cast, by language. Both lists are the same length and are used by position, so a person is
 * the same person in either language: the same meetings, the same joins and leaves, the same
 * headline percentage. Only the name and the address derived from it change.
 */
export const PEOPLE_BY_LANGUAGE = Object.freeze({
  pl: Object.freeze([
    'Anna Kowalska', 'Piotr Nowak', 'Katarzyna Wiśniewska', 'Michał Wójcik',
    'Agnieszka Kamińska', 'Tomasz Lewandowski', 'Magdalena Zielińska', 'Paweł Szymański',
    'Joanna Woźniak', 'Marcin Dąbrowski', 'Ewa Kozłowska', 'Krzysztof Jankowski',
    'Monika Mazur', 'Łukasz Krawczyk', 'Natalia Piotrowska', 'Jakub Grabowski',
    'Karolina Pawlak', 'Adam Michalski', 'Marta Król', 'Wojciech Wieczorek',
    'Alicja Jabłońska', 'Robert Zając'
  ]),
  en: Object.freeze([
    'Emma Wilson', 'James Bennett', 'Olivia Hayes', 'Daniel Foster',
    'Sophie Grant', 'Thomas Wright', 'Grace Mitchell', 'Oliver Brooks',
    'Chloe Palmer', 'Nathan Reed', 'Hannah Cole', 'Christopher Lane',
    'Megan Shaw', 'Lucas Harper', 'Natalie Price', 'Jacob Ellis',
    'Caroline Webb', 'Adam Fletcher', 'Martha King', 'William Barnes',
    'Alice Newman', 'Robert Hughes'
  ])
});

export const PEOPLE = PEOPLE_BY_LANGUAGE.pl;

/** Rosters are ranges over the cast rather than names, which is what keeps the two languages level. */
const GROUPS = Object.freeze([
  { id: 'grp-ai', color: 'teal', roster: [0, 18] },
  { id: 'grp-auto', color: 'violet', roster: [2, 20] },
  { id: 'grp-digital', color: 'amber', roster: [4, 22] }
]);

/**
 * A session is named for what it covered, not for its number: a register full of "Module 3" says
 * nothing about the product, and the sessions of one series still read as a course when they are
 * lined up. The series each meeting belongs to is a column of its own on the list, so the title
 * does not repeat it.
 */
const DEMO_COPY = Object.freeze({
  pl: Object.freeze({
    groups: Object.freeze({
      'grp-ai': 'AI w praktyce zawodowej',
      'grp-auto': 'Automatyzacja pracy zespołu',
      'grp-digital': 'Akademia kompetencji cyfrowych'
    }),
    titles: Object.freeze({
      'demo-ai-01': 'Wprowadzenie do modeli językowych',
      'demo-ai-02': 'Prompty w codziennej pracy',
      'demo-ai-03': 'Automatyzacja zadań z AI',
      'demo-ai-04': 'Etyka i bezpieczeństwo danych',
      'demo-auto-01': 'Mapowanie procesów zespołu',
      'demo-auto-02': 'Integracje i webhooki',
      'demo-auto-03': 'Raporty bez pracy ręcznej',
      'demo-auto-04': 'Wdrożenie i utrzymanie',
      'demo-digital-01': 'Higiena cyfrowa i hasła',
      'demo-digital-02': 'Praca w chmurze',
      'demo-digital-03': 'Arkusze kalkulacyjne w praktyce',
      'demo-consult': 'Konsultacje projektowe'
    }),
    spreadsheetName: 'Frekwencja · szkolenia 2026'
  }),
  en: Object.freeze({
    groups: Object.freeze({
      'grp-ai': 'AI in Professional Practice',
      'grp-auto': 'Team Workflow Automation',
      'grp-digital': 'Digital Skills Academy'
    }),
    titles: Object.freeze({
      'demo-ai-01': 'Introduction to Language Models',
      'demo-ai-02': 'Prompting in Everyday Work',
      'demo-ai-03': 'Automating Tasks with AI',
      'demo-ai-04': 'Ethics and Data Safety',
      'demo-auto-01': 'Mapping Team Processes',
      'demo-auto-02': 'Integrations and Webhooks',
      'demo-auto-03': 'Reports Without Manual Work',
      'demo-auto-04': 'Rollout and Maintenance',
      'demo-digital-01': 'Digital Hygiene and Passwords',
      'demo-digital-02': 'Working in the Cloud',
      'demo-digital-03': 'Spreadsheets in Practice',
      'demo-consult': 'Project Consultations'
    }),
    spreadsheetName: 'Attendance · Training 2026'
  })
});

const MEETING_BLUEPRINTS = Object.freeze([
  { id: 'demo-ai-04', daysAgo: 3, hour: 7, minutes: 480, groupId: 'grp-ai', session: 4, code: 'aiw-prak-tyc' },
  { id: 'demo-auto-04', daysAgo: 7, hour: 8, minutes: 300, groupId: 'grp-auto', session: 4, code: 'aut-biur-pro' },
  { id: 'demo-digital-03', daysAgo: 11, hour: 7, minutes: 240, groupId: 'grp-digital', session: 3, code: 'cyf-komp-zes' },
  { id: 'demo-ai-03', daysAgo: 15, hour: 7, minutes: 480, groupId: 'grp-ai', session: 3, code: 'aiw-prak-tyc' },
  { id: 'demo-auto-03', daysAgo: 22, hour: 8, minutes: 300, groupId: 'grp-auto', session: 3, code: 'aut-biur-pro' },
  { id: 'demo-digital-02', daysAgo: 29, hour: 7, minutes: 240, groupId: 'grp-digital', session: 2, code: 'cyf-komp-zes' },
  { id: 'demo-ai-02', daysAgo: 36, hour: 7, minutes: 480, groupId: 'grp-ai', session: 2, code: 'aiw-prak-tyc' },
  { id: 'demo-auto-02', daysAgo: 43, hour: 8, minutes: 300, groupId: 'grp-auto', session: 2, code: 'aut-biur-pro' },
  { id: 'demo-consult', daysAgo: 50, hour: 12, minutes: 120, session: 1, code: 'kon-sult-pro' },
  { id: 'demo-digital-01', daysAgo: 57, hour: 7, minutes: 240, groupId: 'grp-digital', session: 1, code: 'cyf-komp-zes' },
  { id: 'demo-ai-01', daysAgo: 64, hour: 7, minutes: 480, groupId: 'grp-ai', session: 1, code: 'aiw-prak-tyc' },
  { id: 'demo-auto-01', daysAgo: 71, hour: 8, minutes: 300, groupId: 'grp-auto', session: 1, code: 'aut-biur-pro' }
]);

function slug(value) {
  return String(value)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/ł/g, 'l')
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.|\.$/g, '');
}

function atMinutes(startMs, minutes) {
  return new Date(startMs + minutes * 60_000).toISOString();
}

function attendeeEvents(startMs, durationMinutes, personIndex, meetingIndex) {
  const latePattern = [-4, 0, 3, 5, 8, 10, 12, 14, 18, 21, 7];
  const earlyPattern = [0, 6, 10, 15, 21, 28, 8, 13, 18, 24, 34];
  const joined = latePattern[(personIndex + meetingIndex * 2) % latePattern.length];
  const early = earlyPattern[(personIndex * 3 + meetingIndex) % earlyPattern.length];
  const leaveAt = Math.max(joined + 20, durationMinutes - early);

  if ((personIndex + meetingIndex * 3) % 11 === 0) {
    const breakStart = Math.round(durationMinutes * 0.48);
    const breakLength = 9 + ((personIndex + meetingIndex) % 8);
    return [
      { time: atMinutes(startMs, joined), type: 'Join' },
      { time: atMinutes(startMs, breakStart), type: 'Leave' },
      { time: atMinutes(startMs, breakStart + breakLength), type: 'Join' },
      { time: atMinutes(startMs, leaveAt), type: 'Leave' }
    ];
  }

  return [
    { time: atMinutes(startMs, joined), type: 'Join' },
    { time: atMinutes(startMs, leaveAt), type: 'Leave' }
  ];
}

function groupById(id) {
  return GROUPS.find(group => group.id === id) || null;
}

/** Who sat in a given meeting, as positions in the cast. */
function attendeeIndexes(blueprint, meetingIndex) {
  if (!blueprint.groupId) {
    return [...Array(22).keys()].filter(index => index % 3 !== 1).slice(0, 12);
  }
  const [from, to] = groupById(blueprint.groupId).roster;
  return [...Array(to - from).keys()]
    .filter(offset => (offset + blueprint.session * 2 + meetingIndex) % 13 !== 0)
    .map(offset => from + offset);
}

function meetingFromBlueprint(blueprint, meetingIndex, anchor, people) {
  const start = new Date(anchor);
  start.setUTCDate(start.getUTCDate() - blueprint.daysAgo);
  start.setUTCHours(blueprint.hour, 0, 0, 0);
  const startMs = start.getTime();
  const endMs = startMs + blueprint.minutes * 60_000;
  const attendance = {};

  attendeeIndexes(blueprint, meetingIndex).forEach(personIndex => {
    attendance[people[personIndex]] = {
      email: `${slug(people[personIndex])}@example.com`,
      events: attendeeEvents(startMs, blueprint.minutes, personIndex, meetingIndex)
    };
  });

  const meeting = {
    id: blueprint.id,
    meetingCode: blueprint.code,
    date: atMinutes(startMs, -5),
    scheduledStart: start.toISOString(),
    scheduledEnd: new Date(endMs).toISOString(),
    endedAt: atMinutes(endMs, 2),
    url: `https://meet.google.com/${blueprint.code}`,
    attendance
  };
  if (blueprint.groupId) meeting.groupId = blueprint.groupId;
  return meeting;
}

export function buildDemoData(now = new Date(), { language = 'pl' } = {}) {
  const anchor = new Date(now);
  if (!Number.isFinite(anchor.getTime())) throw new TypeError('now must be a valid date');
  const locale = language === 'en' ? 'en' : 'pl';
  const copy = DEMO_COPY[locale];
  const people = PEOPLE_BY_LANGUAGE[locale];

  const history = MEETING_BLUEPRINTS
    .map((blueprint, index) => {
      const meeting = meetingFromBlueprint(blueprint, index, anchor, people);
      meeting.meetingTitle = copy.titles[blueprint.id];
      return meeting;
    })
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));

  const createdAt = new Date(anchor.getTime() - 120 * 86_400_000).toISOString();
  const groups = GROUPS.map(group => ({
    id: group.id,
    color: group.color,
    name: copy.groups[group.id],
    roster: people.slice(group.roster[0], group.roster[1]),
    createdAt
  }));

  return {
    schemaVersion: 4,
    history,
    groups,
    roster: [...people],
    settings: {
      autoSync: true,
      syncInterval: 5,
      spreadsheetId: 'demo-frekwencja-2026',
      spreadsheetName: copy.spreadsheetName,
      maxStoredMeetings: 200,
      theme: 'dark'
    },
    autoTrack: true,
    language: locale,
    live: {
      onMeet: true,
      tracking: true,
      meetingId: 'demo-ai-04',
      participantCount: 16,
      title: history.find(meeting => meeting.id === 'demo-ai-04')?.meetingTitle || ''
    }
  };
}
