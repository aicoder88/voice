// Unit tests for the pure hotkey decision logic shared by both backends.
// Run: node --test scripts/unit/hotkey-logic.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHoldTracker } from "../../src/hotkey-logic.js";

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
