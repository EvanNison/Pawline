import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDays,
  dayNum,
  daysBetween,
  dayRangeEpoch,
  isValidTimezone,
  lastCompleteDate,
  localDate,
  midnightEpoch,
} from "../time";

const iso = (s: number) => new Date(s * 1000).toISOString();
const NY = "America/New_York";
const VIENNA = "Europe/Vienna";
const TOKYO = "Asia/Tokyo";

test("midnight resolves the offset in force on that date", () => {
  // EDT (UTC-4) in July, EST (UTC-5) in January. A fixed offset gets one wrong.
  assert.equal(iso(midnightEpoch("2026-07-15", NY)), "2026-07-15T04:00:00.000Z");
  assert.equal(iso(midnightEpoch("2026-01-15", NY)), "2026-01-15T05:00:00.000Z");
});

test("DST transition days are not 24 hours long", () => {
  const [sfStart, sfEnd] = dayRangeEpoch("2026-03-08", NY); // spring forward
  assert.equal((sfEnd - sfStart) / 3600, 23);
  const [fbStart, fbEnd] = dayRangeEpoch("2026-11-01", NY); // fall back
  assert.equal((fbEnd - fbStart) / 3600, 25);
});

test("day ranges are contiguous with no gap or overlap", () => {
  let cursor = "2026-03-06";
  for (let i = 0; i < 5; i++) {
    const [, end] = dayRangeEpoch(cursor, NY);
    const next = addDays(cursor, 1);
    assert.equal(end, dayRangeEpoch(next, NY)[0], `gap after ${cursor}`);
    cursor = next;
  }
});

test("timezones east of UTC work", () => {
  assert.equal(iso(midnightEpoch("2026-01-15", VIENNA)), "2026-01-14T23:00:00.000Z");
  assert.equal(iso(midnightEpoch("2026-01-15", TOKYO)), "2026-01-14T15:00:00.000Z");
});

test("southern-hemisphere DST runs the other way", () => {
  const syd = "Australia/Sydney";
  // AEDT (UTC+11) in January, AEST (UTC+10) in July — inverted vs New York.
  assert.equal(iso(midnightEpoch("2026-01-15", syd)), "2026-01-14T13:00:00.000Z");
  assert.equal(iso(midnightEpoch("2026-07-15", syd)), "2026-07-14T14:00:00.000Z");
});

test("calendar arithmetic crosses month and year boundaries", () => {
  assert.equal(addDays("2026-01-31", 1), "2026-02-01");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(addDays("2024-03-01", -1), "2024-02-29", "leap year");
  assert.equal(daysBetween("2026-01-01", "2026-03-01"), 59);
  assert.equal(dayNum("2026-01-02") - dayNum("2026-01-01"), 1);
});

test("addDays is stable across a DST transition", () => {
  // Naive date maths that adds 86400000ms lands on the same day twice here.
  assert.equal(addDays("2026-11-01", 1), "2026-11-02");
  assert.equal(addDays("2026-03-08", 1), "2026-03-09");
});

test("lastCompleteDate is yesterday in the pet's zone, not UTC", () => {
  // 02:00 UTC on the 10th is still the 9th in New York, so the last finished
  // New York day is the 8th — while in Tokyo it is already the 9th.
  const at = new Date("2026-06-10T02:00:00Z");
  assert.equal(localDate(NY, at), "2026-06-09");
  assert.equal(lastCompleteDate(NY, at), "2026-06-08");
  assert.equal(localDate(TOKYO, at), "2026-06-10");
  assert.equal(lastCompleteDate(TOKYO, at), "2026-06-09");
});

test("timezone validation", () => {
  assert.equal(isValidTimezone(NY), true);
  assert.equal(isValidTimezone("Mars/Olympus_Mons"), false);
});
