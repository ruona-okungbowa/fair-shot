// The draw, in the locked order: close, review flags, publish hash, named round fires,
// rank each size, capture and void, promote in drawn order. Each step checks the one before.
import { allocate, commit, rank, roundTime, QUICKNET, type Entry } from "./draw.ts";
import type { Drop } from "./drops.ts";

export type HeldEntry = {
  id: string; // random, so the public list never shows who entered
  dropId: string;
  payerId: string;
  size: string;
  authorizationId: string;
  name: string;
  address: string;
  postcode: string;
  enteredAt: string;
};

export type Flag = { a: string; b: string; by: "code" | "claude"; reason: string; resolved?: "different" | "removed" };

type Status = "held" | "removed" | "reserve" | "captured" | "capture_failed" | "capture_unknown" | "voided" | "void_failed";
type Step = "open" | "closed" | "committed" | "drawn" | "settled" | "done";

export type DrawState = {
  drop: Drop;
  entries: HeldEntry[];
  reserves: number;
  step: Step;
  busy: boolean;
  flags: Flag[];
  status: Record<string, Status>;
  hash?: string;
  publishedAt?: string;
  randomness?: string;
  ranked?: Record<string, string[]>;
  log: { step: string; at: string; detail: string }[];
};

export type DrawDeps = {
  now: () => number;
  // Claude's only power over households is to raise a flag.
  reviewPair: (a: HeldEntry, b: HeldEntry) => Promise<{ flag: boolean; reason: string }>;
  beacon: (round: number) => Promise<string>;
  // Must throw an error with `declined: true` only for a definite no (see PayPalError).
  capture: (authorizationId: string, requestId: string) => Promise<unknown>;
  voidHold: (authorizationId: string) => Promise<unknown>;
};

// The hash must be public at least this long before the named round fires.
const PUBLISH_MARGIN_MS = 60_000;

export function newDraw(drop: Drop, entries: HeldEntry[], reserves: number): DrawState {
  const stray = entries.find((e) => e.dropId !== drop.id);
  if (stray) throw new Error(`entry ${stray.id} belongs to ${stray.dropId}, not ${drop.id}`);
  return {
    drop,
    entries,
    reserves,
    step: "open",
    busy: false,
    flags: [],
    status: Object.fromEntries(entries.map((e) => [e.id, "held" as Status])),
    log: [],
  };
}

const at = (deps: DrawDeps) => new Date(deps.now()).toISOString();
const log = (s: DrawState, deps: DrawDeps, step: string, detail: string) => s.log.push({ step, at: at(deps), detail });

function advance(s: DrawState, to: Step, deps: DrawDeps, detail: string) {
  s.step = to;
  log(s, deps, to, detail);
}

// One step at a time: a double-click in the console must not run captures or voids twice.
async function exclusive<T>(s: DrawState, from: Step, name: string, fn: () => Promise<T>): Promise<T> {
  if (s.step !== from) throw new Error(`cannot ${name} from ${s.step}`);
  if (s.busy) throw new Error("another step is still running");
  s.busy = true;
  try {
    return await fn();
  } finally {
    s.busy = false;
  }
}

const postcodeKey = (p: string) => p.replace(/\s+/g, "").toUpperCase();
const addressKey = (a: string) => a.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const declined = (err: unknown) => (err as { declined?: boolean } | null)?.declined === true;

// The list that gets hashed and drawn: ids and sizes only, removed entries left out.
export const publicEntries = (s: DrawState): Entry[] =>
  s.entries.filter((e) => s.status[e.id] !== "removed").map((e) => ({ id: e.id, size: e.size }));

// Step 1: close, then raise household flags for every pair sharing a postcode.
export const close = (s: DrawState, deps: DrawDeps) =>
  exclusive(s, "open", "close", async () => {
    if (deps.now() < Date.parse(s.drop.closesAt)) throw new Error("the drop has not closed yet");
    const flags: Flag[] = []; // saved only once every pair is reviewed, so a retry never duplicates
    for (const group of Map.groupBy(s.entries, (e) => postcodeKey(e.postcode)).values()) {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const [a, b] = [group[i], group[j]];
          if (addressKey(a.address) === addressKey(b.address)) {
            flags.push({ a: a.id, b: b.id, by: "code", reason: "same address" });
            continue;
          }
          const r = await deps.reviewPair(a, b);
          if (r.flag) flags.push({ a: a.id, b: b.id, by: "claude", reason: r.reason });
        }
      }
    }
    s.flags = flags;
    advance(s, "closed", deps, `${s.entries.length} entries, ${flags.length} flags`);
  });

// Step 2: only the organiser resolves a flag. Removing an entry voids its hold.
export const resolveFlag = (s: DrawState, index: number, removeId: string | null, deps: DrawDeps) =>
  exclusive(s, "closed", "review flags", async () => {
    const f = s.flags[index];
    if (!f || f.resolved) throw new Error(`no open flag at ${index}`);
    if (removeId === null) {
      f.resolved = "different";
      log(s, deps, "review", `flag ${index}: different households`);
      return;
    }
    if (removeId !== f.a && removeId !== f.b) throw new Error("can only remove one of the flagged pair");
    const entry = s.entries.find((e) => e.id === removeId)!;
    await deps.voidHold(entry.authorizationId);
    s.status[removeId] = "removed";
    for (const g of s.flags) if (!g.resolved && (g.a === removeId || g.b === removeId)) g.resolved = "removed";
    log(s, deps, "review", `flag ${index}: removed ${removeId}, hold voided`);
  });

// Step 3: the hash must be public before the named round exists, or the draw could be steered.
export const publish = (s: DrawState, deps: DrawDeps) =>
  exclusive(s, "closed", "publish the hash", async () => {
    if (s.flags.some((f) => !f.resolved)) throw new Error("household flags are still open");
    if (deps.now() > roundTime(s.drop.drandRound) - PUBLISH_MARGIN_MS) {
      throw new Error("too close to or past the named drand round; the draw must be rescheduled publicly");
    }
    s.hash = await commit(publicEntries(s));
    s.publishedAt = at(deps);
    advance(s, "committed", deps, `hash ${s.hash}`);
  });

// Steps 4 and 5: fetch the named round once it fires, then rank each size.
export const draw = (s: DrawState, deps: DrawDeps) =>
  exclusive(s, "committed", "draw", async () => {
    if (deps.now() < roundTime(s.drop.drandRound)) throw new Error("the named drand round has not fired yet");
    s.randomness = await deps.beacon(s.drop.drandRound);
    s.ranked = await rank(publicEntries(s), s.randomness);
    advance(s, "drawn", deps, `round ${s.drop.drandRound}`);
  });

// Same request id on every try, so PayPal returns the original result instead of charging twice.
async function tryCapture(s: DrawState, id: string, deps: DrawDeps): Promise<Status> {
  const e = s.entries.find((x) => x.id === id)!;
  let result: Status;
  try {
    await deps.capture(e.authorizationId, `capture-${id}`);
    result = "captured";
  } catch (err) {
    // A timeout may have captured, so it is never promoted over until retried.
    result = declined(err) ? "capture_failed" : "capture_unknown";
    if (result === "capture_failed") await deps.voidHold(e.authorizationId).catch(() => {}); // often already gone
  }
  s.status[id] = result;
  return result;
}

async function tryVoid(s: DrawState, id: string, deps: DrawDeps) {
  const e = s.entries.find((x) => x.id === id)!;
  try {
    await deps.voidHold(e.authorizationId);
    s.status[id] = "voided";
  } catch {
    s.status[id] = "void_failed"; // left visible in the hold ledger for the organiser to retry
  }
}

// Step 6: capture winners, void everyone beyond the reserves. Reserves keep their holds.
export const settle = (s: DrawState, deps: DrawDeps) =>
  exclusive(s, "drawn", "settle", async () => {
    const plan = allocate(s.ranked!, s.drop.stock, s.reserves);
    for (const id of plan.reserve) s.status[id] = "reserve";
    for (const id of plan.capture) await tryCapture(s, id, deps);
    for (const id of plan.void) await tryVoid(s, id, deps);
    advance(s, "settled", deps, `${plan.capture.length} winners, ${plan.reserve.length} reserves`);
  });

// Organiser retry for a capture PayPal gave no definite answer on.
export const retryCapture = (s: DrawState, id: string, deps: DrawDeps) =>
  exclusive(s, "settled", "retry a capture", async () => {
    if (s.status[id] !== "capture_unknown") throw new Error(`${id} is ${s.status[id]}, not capture_unknown`);
    await tryCapture(s, id, deps);
    log(s, deps, "retry", `${id}: ${s.status[id]}`);
  });

// Step 7: fill each declined capture from the reserves in drawn order, then release the rest.
// Safe to run again after retries: it recounts empty slots from the statuses.
export const promote = (s: DrawState, deps: DrawDeps) =>
  exclusive(s, "settled", "promote", async () => {
    for (const [size, ids] of Object.entries(s.ranked!)) {
      const count = (st: Status) => ids.filter((id) => s.status[id] === st).length;
      let missing = (s.drop.stock[size] ?? 0) - count("captured") - count("capture_unknown");
      for (const id of ids) {
        if (s.status[id] !== "reserve") continue;
        if (missing > 0) {
          if ((await tryCapture(s, id, deps)) !== "capture_failed") missing--;
        } else if (count("capture_unknown") === 0) {
          await tryVoid(s, id, deps); // reserves stay held while any capture in this size is unknown
        }
      }
      if (missing > 0 && count("reserve") === 0) log(s, deps, "promote", `${size}: ${missing} unsold, reserves used up`);
    }
    const unknown = Object.values(s.status).filter((x) => x === "capture_unknown").length;
    if (unknown) throw new Error(`${unknown} captures have no definite answer from PayPal; retry them, then promote again`);
    advance(s, "done", deps, "reserves promoted or released");
  });

// Everything the Verify page needs to rerun the draw.
export const proof = (s: DrawState) => ({
  dropId: s.drop.id,
  chainHash: QUICKNET.chainHash,
  drandRound: s.drop.drandRound,
  hash: s.hash,
  publishedAt: s.publishedAt,
  entries: publicEntries(s),
  randomness: s.randomness,
  ranked: s.ranked,
});
