/**
 * Calendar dates, in the timezone the school actually lives in.
 *
 * The bug this exists to prevent shipped once already: an endpoint defaulted
 * "today" to `new Date().toISOString().slice(0, 10)`, which reads the HOST's
 * zone. A serverless host runs in UTC, six hours behind Dhaka, so between
 * 18:00 and 24:00 UTC — 00:00 to 06:00 in Bangladesh — that expression names
 * the PREVIOUS day. Those are exactly the hours in which a teacher checks
 * the routine before leaving for school, and they were handed yesterday's
 * timetable.
 *
 * It lives in server-core rather than beside one endpoint because the same
 * trap is reachable from every service that defaults a date, and two of them
 * had already reached it.
 */

/**
 * Bangladesh is UTC+6 with no daylight saving. It ran the experiment once,
 * in the second half of 2009, and has not repeated it — so a fixed offset is
 * exact here rather than an approximation.
 *
 * Tenants do carry a timezone (`tenants.timezone`, migration 001, default
 * 'Asia/Dhaka'). The day a school outside Bangladesh exists, these helpers
 * should take it as a parameter; until then a named constant states the
 * assumption out loud instead of burying it in an arithmetic literal.
 */
export const DHAKA_UTC_OFFSET_MS = 6 * 60 * 60 * 1000;

/**
 * Today's calendar date in Dhaka, as YYYY-MM-DD.
 *
 * Shifting the instant and then reading UTC fields is the same idiom
 * `sundayOnOrBefore` uses, so both agree on where a calendar day begins.
 * `now` is injected only so the midnight boundary is testable; every caller
 * uses the default.
 */
export function dhakaToday(now: number = Date.now()): string {
  return new Date(now + DHAKA_UTC_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * The Sunday on or before `iso`. Bangladesh's school week starts Sunday —
 * see the comment in migration 006.
 *
 * Takes a date string rather than an instant, so it is unaffected by the
 * host clock and needs no offset of its own.
 */
export function sundayOnOrBefore(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}
