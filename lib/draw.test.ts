import { test } from "node:test";
import assert from "node:assert/strict";
import { allocate, commit, rank, roundAt, roundTime, type Entry } from "./draw.ts";

// Real quicknet round 1000000.
const RANDOMNESS = "b22aad4794f7451896f7a371aa46106fd84d919f3f569acd5b2fddf1d1440af3";

const entries: Entry[] = [
  { id: "agent-0.4s", size: "UK5" },
  { id: "fan-hours-later", size: "UK5" },
  { id: "e3", size: "UK5" },
  { id: "e4", size: "UK6" },
  { id: "e5", size: "UK6" },
];

test("round maths matches the real chain", () => {
  assert.equal(roundTime(1_000_000), 1_695_803_364_000);
  assert.equal(roundAt(1_695_803_364_000), 1_000_000);
  assert.equal(roundAt(1_695_803_364_001), 1_000_001);
});

test("commitment ignores arrival order but catches any change", async () => {
  const h = await commit(entries);
  assert.equal(await commit([...entries].reverse()), h);
  assert.notEqual(await commit([...entries, { id: "e6", size: "UK6" }]), h);
  assert.notEqual(await commit(entries.map((e, i) => (i ? e : { ...e, size: "UK6" }))), h);
});

test("same inputs give the same ranks; sizes rank independently", async () => {
  const a = await rank(entries, RANDOMNESS);
  assert.deepEqual(await rank([...entries].reverse(), RANDOMNESS), a);
  assert.deepEqual(Object.keys(a).sort(), ["UK5", "UK6"]);
  assert.equal(a.UK5.length + a.UK6.length, entries.length);
  assert.deepEqual(a.UK6, (await rank(entries.filter((e) => e.size === "UK6"), RANDOMNESS)).UK6);
  assert.notDeepEqual(await rank(entries, "00".repeat(32)), a); // guards against randomness being ignored
});

test("allocate splits capture, reserve and void per size", () => {
  const out = allocate({ UK5: ["a", "b", "c", "d"], UK6: ["e"] }, { UK5: 1, UK6: 2 }, 2);
  assert.deepEqual(out, { capture: ["a", "e"], reserve: ["b", "c"], void: ["d"] });
});

test("negative stock or reserves never put an id in two buckets", () => {
  const out = allocate({ UK5: ["a", "b"] }, { UK5: -1 }, -1);
  assert.deepEqual(out, { capture: [], reserve: [], void: ["a", "b"] });
});

test("duplicate entry ids are rejected", async () => {
  const dup = [...entries, { id: "e3", size: "UK6" }];
  await assert.rejects(commit(dup), /duplicate entry id/);
  await assert.rejects(rank(dup, RANDOMNESS), /duplicate entry id/);
});
