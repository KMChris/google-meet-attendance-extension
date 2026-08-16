/**
 * The demo's clock, stopped.
 *
 * The register is built around a reference date, but the pages around it still ask the machine what
 * time it is: the analytics range runs "90 days back from today", a sync stamps itself with the
 * moment it ran, and a meeting is described by how long ago it was. Left alone, every one of those
 * reads the day the screenshots happen to be taken — which is how a pack of frames dated 14 August
 * ends up with a summary line dated whenever the tool was last run.
 *
 * So the whole page is told a single "now", the same one the data was built for. Only the argument
 * free forms move: `new Date(x)` and `Date.parse` are the real ones, because they are asked about
 * dates that already exist rather than about the present.
 */

export function freezeClock(iso) {
  const fixed = new Date(iso).getTime();
  if (!Number.isFinite(fixed)) throw new TypeError(`freezeClock needs a real date, got ${iso}`);

  const Real = Date;
  class Frozen extends Real {
    constructor(...args) {
      super(...(args.length ? args : [fixed]));
    }
    static now() { return fixed; }
  }
  Object.defineProperty(Frozen, 'name', { value: 'Date' });

  globalThis.Date = Frozen;
  return () => { globalThis.Date = Real; };
}
