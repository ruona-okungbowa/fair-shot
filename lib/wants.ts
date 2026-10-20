import { z } from "zod";

// What the shopper approved. The agent never changes it; only the shopper's yes answers do.
export const WantsCard = z.object({
  sizes: z.array(z.string()).describe('Sizes they will accept, written like "UK 5"'),
  avoid: z.array(z.string()).describe('Colours or features they ruled out, e.g. "pink"'),
  maxTotalP: z.number().int().describe("Most they will pay including delivery, in pence"),
  rulings: z.array(z.string()).describe("Yes/no questions the shopper has already answered"),
});
export type WantsCard = z.infer<typeof WantsCard>;

export const WantsDraft = WantsCard.omit({ rulings: true });

export const Decision = z.object({
  verdict: z.enum(["match", "no_match", "unsure"]),
  size: z.string().nullable().describe("The one size to enter, as the page writes it; null unless match"),
  quotes: z.array(z.string()).describe("Page text the decision rests on, copied character for character"),
  reason: z.string().describe("One sentence for the shopper"),
  question: z.string().nullable().describe('Yes/no question when unsure, where "yes" means go ahead'),
  ifYesSize: z.string().nullable().describe("A size not on the card that a yes would approve"),
});
export type Decision = z.infer<typeof Decision>;

// A yes answer is the only way the card grows.
export function applyYes(card: WantsCard, d: Decision): WantsCard {
  if (d.verdict !== "unsure" || !d.question) throw new Error("only an unsure decision with a question can be answered yes");
  return {
    ...card,
    sizes: d.ifYesSize ? [...card.sizes, d.ifYesSize] : card.sizes,
    rulings: [...card.rulings, `${d.question} Yes.`],
  };
}
