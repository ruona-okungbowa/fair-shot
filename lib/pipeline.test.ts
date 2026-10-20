import { test } from "node:test";
import assert from "node:assert/strict";
import { commit, rank, roundTime } from "./draw.ts";
import { findDrop } from "./drops.ts";
import { close, draw, newDraw, promote, proof, publish, resolveFlag, retryCapture, settle, type DrawDeps, type HeldEntry } from "./pipeline.ts";

const RANDOMNESS = "b22aad4794f7451896f7a371aa46106fd84d919f3f569acd5b2fddf1d1440af3";
const drop = { ...findDrop("kestrel-tidewater")!, stock: { "UK 5": 1, "UK 6": 1 } };
const CLOSE = Date.parse(drop.closesAt);
const ROUND = roundTime(drop.drandRound);

const entry = (id: string, size: string, address: string, postcode = "AB1 2CD"): HeldEntry => ({
  id, dropId: drop.id, payerId: `P-${id}`, size, authorizationId: `AUTH-${id}`,
  name: `Name ${id}`, address, postcode, enteredAt: "2026-10-31T09:00:00Z",
});

// a and g share a postcode, different addresses (Claude flags them); e and f share an address (code flags them).
const entries = [
  entry("a", "UK 5", "1 Mill Lane"),
  entry("b", "UK 5", "4 Rope Walk", "ZZ9 9ZZ"),
  entry("c", "UK 5", "7 Quay St", "YY8 8YY"),
  entry("d", "UK 5", "9 Dock Rd", "XX7 7XX"),
  entry("g", "UK 5", "1a Mill Lane"),
  entry("e", "UK 6", "Flat 2, 10 High St", "CD3 4EF"),
  entry("f", "UK 6", "flat 2 10 high st.", "cd34ef"),
];

function deps() {
  const calls: string[] = [];
  let now = CLOSE;
  const failCapture = new Set<string>();
  const timeoutCapture = new Set<string>();
  const d: DrawDeps = {
    now: () => now,
    reviewPair: async (a, b) => ({ flag: a.address.includes("Mill") && b.address.includes("Mill"), reason: "same street, 1 vs 1a" }),
    beacon: async (round) => { calls.push(`beacon ${round}`); return RANDOMNESS; },
    capture: async (auth) => {
      calls.push(`capture ${auth}`);
      if (failCapture.has(auth)) throw Object.assign(new Error("DECLINED"), { declined: true });
      if (timeoutCapture.has(auth)) throw new Error("fetch failed");
    },
    voidHold: async (auth) => { calls.push(`void ${auth}`); },
  };
  return { d, calls, failCapture, timeoutCapture, setNow: (t: number) => (now = t) };
}

test("full draw: flags, hash before round, capture, void, promote in drawn order", async () => {
  const { d, calls, failCapture, setNow } = deps();
  const s = newDraw(drop, entries, 2);

  await close(s, d);
  assert.deepEqual(s.flags.map((f) => [f.a, f.b, f.by]), [["a", "g", "claude"], ["e", "f", "code"]]);

  await assert.rejects(publish(s, d), /flags are still open/);
  await resolveFlag(s, 0, null, d); // a and g are neighbours
  await resolveFlag(s, 1, "f", d); // e and f are one household
  assert.ok(calls.includes("void AUTH-f"));

  await assert.rejects(draw(s, d), /cannot draw from closed/);
  await publish(s, d);
  assert.equal(s.hash, await commit(entries.filter((e) => e.id !== "f").map(({ id, size }) => ({ id, size }))));

  await assert.rejects(draw(s, d), /has not fired yet/);
  setNow(ROUND);
  await draw(s, d);
  assert.ok(calls.includes(`beacon ${drop.drandRound}`));

  const uk5 = s.ranked!["UK 5"];
  failCapture.add(`AUTH-${uk5[0]}`); // the first-drawn winner's capture fails
  await settle(s, d);
  assert.equal(s.status[uk5[0]], "capture_failed");
  assert.deepEqual([s.status[uk5[1]], s.status[uk5[2]]], ["reserve", "reserve"]);
  assert.deepEqual(uk5.slice(3).map((id) => s.status[id]), ["voided", "voided"]);
  assert.equal(s.status.e, "captured");

  await promote(s, d);
  assert.equal(s.status[uk5[1]], "captured"); // next in drawn order gets it
  assert.equal(s.status[uk5[2]], "voided"); // unused reserve released
  assert.ok(calls.indexOf(`capture AUTH-${uk5[1]}`) < calls.indexOf(`void AUTH-${uk5[2]}`));
  assert.equal(s.step, "done");
});

test("anyone can rerun the draw from the proof", async () => {
  const { d, setNow } = deps();
  const s = newDraw(drop, entries, 1);
  await close(s, d);
  await resolveFlag(s, 0, null, d);
  await resolveFlag(s, 1, "f", d);
  await publish(s, d);
  setNow(ROUND);
  await draw(s, d);
  const p = proof(s);
  assert.equal(await commit(p.entries), p.hash);
  assert.deepEqual(await rank(p.entries, p.randomness!), p.ranked);
  assert.ok(!JSON.stringify(p).includes("Mill Lane") && !JSON.stringify(p).includes("P-a")); // no names, addresses or payer ids
});

test("the hash cannot be published within a minute of the named round, or after it", async () => {
  const { d, setNow } = deps();
  const s = newDraw(drop, [entry("a", "UK 5", "1 Mill Lane")], 1);
  await close(s, d);
  setNow(ROUND - 30_000);
  await assert.rejects(publish(s, d), /rescheduled publicly/);
  setNow(ROUND);
  await assert.rejects(publish(s, d), /rescheduled publicly/);
});

async function drawnState(reserves: number) {
  const t = deps();
  const s = newDraw(drop, entries, reserves);
  await close(s, t.d);
  await resolveFlag(s, 0, null, t.d);
  await resolveFlag(s, 1, "f", t.d);
  await publish(s, t.d);
  t.setNow(ROUND);
  await draw(s, t.d);
  return { s, ...t };
}

test("a capture with no definite answer is never promoted over until retried", async () => {
  const { s, d, timeoutCapture, calls } = await drawnState(2);
  const uk5 = s.ranked!["UK 5"];
  timeoutCapture.add(`AUTH-${uk5[0]}`);
  await settle(s, d);
  assert.equal(s.status[uk5[0]], "capture_unknown");

  await assert.rejects(promote(s, d), /no definite answer/);
  assert.ok(!calls.includes(`capture AUTH-${uk5[1]}`)); // reserve not charged
  assert.deepEqual([s.status[uk5[1]], s.status[uk5[2]]], ["reserve", "reserve"]); // and still held
  assert.equal(s.step, "settled");

  timeoutCapture.clear(); // PayPal answers on retry (same request id, so no double charge)
  await retryCapture(s, uk5[0], d);
  assert.equal(s.status[uk5[0]], "captured");
  await promote(s, d);
  assert.deepEqual([s.status[uk5[1]], s.status[uk5[2]]], ["voided", "voided"]);
  assert.equal(s.step, "done");
});

test("a double-click cannot run a step twice", async () => {
  const { s, d } = await drawnState(1);
  const results = await Promise.allSettled([settle(s, d), settle(s, d)]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  assert.match(String((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason), /still running/);
});

test("a retried close does not duplicate flags, and entries must belong to the drop", async () => {
  const { d } = deps();
  let calls = 0;
  const flaky = d.reviewPair;
  d.reviewPair = async (a, b) => { if (calls++ === 0) throw new Error("API down"); return flaky(a, b); };
  const s = newDraw(drop, entries, 1);
  await assert.rejects(close(s, d), /API down/);
  await close(s, d);
  assert.equal(s.flags.length, 2);
  assert.throws(() => newDraw(drop, [{ ...entries[0], dropId: "other" }], 1), /belongs to other/);
});

test("the drop cannot close early, and Claude saying no flag never clears a code flag", async () => {
  const { d, setNow } = deps();
  d.reviewPair = async () => ({ flag: false, reason: "looks fine" });
  const s = newDraw(drop, entries, 1);
  setNow(CLOSE - 1);
  await assert.rejects(close(s, d), /not closed yet/);
  setNow(CLOSE);
  await close(s, d);
  assert.deepEqual(s.flags.map((f) => f.by), ["code"]);
  await assert.rejects(resolveFlag(s, 0, "a", d), /one of the flagged pair/);
});
