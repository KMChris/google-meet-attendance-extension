import { buildDemoData, DEMO_ANCHOR } from './demo-data.mjs';
import { createChromeMock } from './demo-chrome.mjs';
import { installSheetsFetch } from './demo-sheets.mjs';
import { freezeClock } from './demo-clock.mjs';

const language = new URLSearchParams(location.search).get('lang') === 'en' ? 'en' : 'pl';
const demo = buildDemoData(new Date(DEMO_ANCHOR), { language });
document.documentElement.lang = language;
globalThis.__ATTENDANCE_DEMO__ = demo;
globalThis.chrome = createChromeMock(demo, { origin: location.origin });
installSheetsFetch(demo);
freezeClock(DEMO_ANCHOR);

await import('/dashboard/dashboard.js');
