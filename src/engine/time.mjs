// time.mjs — the station's day is the Europe/Dublin calendar day (ENGINE-PLAN.md §5.1; DECISIONS.md 7): daily caps,
// the office's "Today" and the event files all roll over at Irish local midnight, daylight saving included.
export const TZ = 'Europe/Dublin';
const DAY_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const PARTS_FMT = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });

// YYYY-MM-DD of `ms` in Dublin
export const dublinDay = (ms = Date.now()) => DAY_FMT.format(new Date(ms));

// epoch ms of 00:00 Dublin time on the Dublin day that contains `ms`
export function dublinDayStart(ms = Date.now()) {
  const p = Object.fromEntries(PARTS_FMT.formatToParts(new Date(ms)).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
  const sinceMidnight = ((p.hour * 60 + p.minute) * 60 + p.second) * 1000 + (ms % 1000 + 1000) % 1000;
  return ms - sinceMidnight;
}

// dd/mm/yyyy (the owner's date format) of a Dublin day key
export const dmyOfDay = (day) => day.slice(8, 10) + '/' + day.slice(5, 7) + '/' + day.slice(0, 4);
// dd/mm/yyyy HH:MM on the Dublin clock (the owner's one date format)
const HM_FMT = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
export const dublinDateTime = (ms = Date.now()) => dmyOfDay(dublinDay(ms)) + ' ' + HM_FMT.format(new Date(ms));
