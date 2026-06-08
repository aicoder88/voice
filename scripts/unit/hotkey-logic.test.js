// Unit tests for the pure hotkey decision logic shared by both backends.
// Run: node --test scripts/unit/hotkey-logic.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTapDetector, createHoldTracker } from "../../src/hotkey-logic.js";

// A controllable clock so timing rules are deterministic (no real timers).
function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test("tap: quick down/up within window is a tap", () => {
  const clk = fakeClock();
  const tap = createTapDetector({ windowMs: 300, now: clk.now });
  tap.down();
  clk.advance(120);
  assert.equal(tap.up(), true);
});

test("tap: held past the window is NOT a tap", () => {
  const clk = fakeClock();
  const tap = createTapDetector({ windowMs: 300, now: clk.now });
  tap.down();
  clk.advance(301);
  assert.equal(tap.up(), false);
});

test("tap: other activity while open cancels the tap (chord)", () => {
  const clk = fakeClock();
  const tap = createTapDetector({ windowMs: 300, now: clk.now });
  tap.down();
  clk.advance(50);
  tap.other(); // e.g. right Alt went down → this was a chord, not a tap
  clk.advance(50);
  assert.equal(tap.up(), false);
});

test("tap: other() before any down is ignored", () => {
  const clk = fakeClock();
  const tap = createTapDetector({ windowMs: 300, now: clk.now });
  tap.other(); // no gesture open — must not latch
  tap.down();
  clk.advance(100);
  assert.equal(tap.up(), true);
});

test("tap: auto-repeat down does not reset the start time", () => {
  const clk = fakeClock();
  const tap = createTapDetector({ windowMs: 300, now: clk.now });
  tap.down();
  clk.advance(200);
  tap.down(); // auto-repeat — should be ignored, NOT restart the clock
  clk.advance(150); // total held = 350ms > window
  assert.equal(tap.up(), false);
});

test("tap: up with no down returns false and stays closed", () => {
  const tap = createTapDetector({ windowMs: 300, now: () => 0 });
  assert.equal(tap.up(), false);
  assert.equal(tap.isOpen(), false);
});

test("tap: state resets so a second tap works", () => {
  const clk = fakeClock();
  const tap = createTapDetector({ windowMs: 300, now: clk.now });
  tap.down(); clk.advance(50); tap.up();
  tap.down(); clk.advance(50);
  assert.equal(tap.up(), true);
});

test("hold: first press fires onPress, last release fires onRelease", () => {
  const events = [];
  const hold = createHoldTracker({
    onPress: (n) => events.push("press:" + n),
    onRelease: (n) => events.push("release:" + n)
  });
  hold.press("alt");
  hold.release("alt");
  assert.deepEqual(events, ["press:alt", "release:alt"]);
});

test("hold: overlapping triggers act as one press/release", () => {
  const events = [];
  const hold = createHoldTracker({
    onPress: () => events.push("press"),
    onRelease: () => events.push("release")
  });
  hold.press("alt");      // fires press
  hold.press("mouseBack"); // already held → no second press
  hold.release("alt");     // still mouseBack held → no release
  hold.release("mouseBack"); // last one → fires release
  assert.deepEqual(events, ["press", "release"]);
  assert.equal(hold.size(), 0);
});

test("hold: auto-repeat press of the same source is ignored", () => {
  let presses = 0;
  const hold = createHoldTracker({ onPress: () => presses++ });
  hold.press("alt");
  hold.press("alt");
  hold.press("alt");
  assert.equal(presses, 1);
});

test("hold: releasing an unheld source does nothing", () => {
  const events = [];
  const hold = createHoldTracker({
    onPress: () => events.push("press"),
    onRelease: () => events.push("release")
  });
  hold.release("ghost");
  assert.deepEqual(events, []);
});
