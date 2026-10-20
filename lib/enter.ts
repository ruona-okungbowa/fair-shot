// The agent's only action. Every limit is re-checked here in code before a PayPal hold is placed.
import type { Drop } from "./drops.ts";
import { Decision, WantsCard } from "./wants.ts";

export type Payer = { payerId: string; vaultId: string };

export type EnterContext = {
  now: number;
  entered: Set<string>; // `${dropId}:${payerId}`
  attempts: Map<string, number>; // bumped only after a definite decline, so that retry gets a fresh PayPal request id
  placeHold: (vaultId: string, value: string, currency: string, requestId: string) => Promise<{ authorizationId: string }>;
};

export type EnterResult =
  | { ok: true; size: string; totalP: number; authorizationId: string }
  | { ok: false; reason: string };

const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const sizeKey = (s: string) => s.replace(/\s+/g, "").toUpperCase();

// Word for word: every quote must appear on the page (whitespace aside).
export const quotesOnPage = (quotes: string[], page: string) =>
  quotes.length > 0 && quotes.every((q) => squash(q) !== "" && squash(page).includes(squash(q)));

export async function enter(
  drop: Drop,
  cardInput: WantsCard,
  decisionInput: Decision,
  payer: Payer,
  ctx: EnterContext,
): Promise<EnterResult> {
  const card = WantsCard.safeParse(cardInput);
  const decision = Decision.safeParse(decisionInput);
  if (!card.success || !decision.success) return { ok: false, reason: "malformed card or decision" };
  const c = card.data;
  const d = decision.data;

  if (ctx.now >= Date.parse(drop.closesAt)) return { ok: false, reason: "entries are closed" };
  if (d.verdict !== "match" || !d.size) return { ok: false, reason: `agent said ${d.verdict}` };
  if (!quotesOnPage(d.quotes, drop.page)) return { ok: false, reason: "a quote is not on the page" };

  const size = Object.keys(drop.stock).find((s) => sizeKey(s) === sizeKey(d.size!));
  if (!size) return { ok: false, reason: `${d.size} is not offered` };
  if (!c.sizes.some((s) => sizeKey(s) === sizeKey(size))) return { ok: false, reason: `${size} is not on the card` };

  const totalP = drop.priceP + drop.deliveryP;
  if (totalP > c.maxTotalP) return { ok: false, reason: `£${(totalP / 100).toFixed(2)} is over the card limit` };

  // Safety net only: catches a ruled-out word in the colour name; the agent judges the rest.
  const banned = c.avoid.find((a) => a.trim() && drop.colour.toLowerCase().includes(a.trim().toLowerCase()));
  if (banned) return { ok: false, reason: `colour "${drop.colour}" contains "${banned}"` };

  const key = `${drop.id}:${payer.payerId}`;
  if (ctx.entered.has(key)) return { ok: false, reason: "this PayPal account has already entered" };
  ctx.entered.add(key); // claimed before the await so a parallel call can't hold twice
  const attempt = ctx.attempts.get(key) ?? 0;
  try {
    const hold = await ctx.placeHold(payer.vaultId, (totalP / 100).toFixed(2), drop.currency, `enter-${key}-${attempt}`);
    return { ok: true, size, totalP, authorizationId: hold.authorizationId };
  } catch (e) {
    ctx.entered.delete(key);
    // After a timeout the same id is reused, so PayPal reports what really happened instead of placing a second hold.
    if ((e as { declined?: boolean }).declined) ctx.attempts.set(key, attempt + 1);
    return { ok: false, reason: `PayPal hold failed: ${(e as Error).message}` };
  }
}
