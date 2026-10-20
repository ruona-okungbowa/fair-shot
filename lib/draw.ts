// Pure draw engine. Runs unchanged in Node and the browser so the Verify page can rerun it.

export type Entry = { id: string; size: string };

// drand quicknet: https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/info
export const QUICKNET = {
  chainHash: "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
  genesis: 1692803367,
  period: 3,
  publicKey:
    "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a",
};

// First round emitted at or after `ms`, so a drop can name it before entries close.
export const roundAt = (ms: number) =>
  Math.ceil((ms / 1000 - QUICKNET.genesis) / QUICKNET.period) + 1;

export const roundTime = (round: number) =>
  (QUICKNET.genesis + (round - 1) * QUICKNET.period) * 1000;

const sha256 = async (s: string) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");

const byKey = <T>(key: (x: T) => string) => (a: T, b: T) => {
  if (key(a) < key(b)) return -1;
  if (key(a) > key(b)) return 1;
  return 0;
};

// A repeated id would share a rank key and could take two stock slots.
function assertUnique(entries: Entry[]) {
  if (new Set(entries.map((e) => e.id)).size !== entries.length) throw new Error("duplicate entry id");
}

// Sorted by id so the hash doesn't depend on the order entries arrived in.
export const canonical = (entries: Entry[]) => {
  assertUnique(entries);
  return JSON.stringify([...entries].sort(byKey((e) => e.id)).map((e) => [e.id, e.size]));
};

export const commit = async (entries: Entry[]) => sha256(canonical(entries));

// Each size is ordered by sha256(randomness:id); entry time plays no part.
export async function rank(entries: Entry[], randomness: string) {
  assertUnique(entries);
  const keyed = await Promise.all(
    entries.map(async (e) => ({ ...e, key: await sha256(`${randomness}:${e.id}`) })),
  );
  keyed.sort(byKey((e) => e.key));
  const bySize: Record<string, string[]> = {};
  for (const e of keyed) (bySize[e.size] ??= []).push(e.id);
  return bySize;
}

// Reserves keep their hold so a failed capture can be promoted in drawn order.
export function allocate(
  ranked: Record<string, string[]>,
  stock: Record<string, number>,
  reserves: number,
) {
  const out = { capture: [] as string[], reserve: [] as string[], void: [] as string[] };
  const r = Math.max(0, reserves);
  for (const [size, ids] of Object.entries(ranked)) {
    const n = Math.max(0, stock[size] ?? 0);
    out.capture.push(...ids.slice(0, n));
    out.reserve.push(...ids.slice(n, n + r));
    out.void.push(...ids.slice(n + r));
  }
  return out;
}
