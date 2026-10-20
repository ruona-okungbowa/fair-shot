import { roundAt } from "./draw.ts";

export type Drop = {
  id: string;
  brand: string;
  title: string;
  colour: string;
  priceP: number;
  deliveryP: number;
  currency: "GBP";
  stock: Record<string, number>;
  closesAt: string;
  drandRound: number;
  page: string;
};

// The round fires 30 minutes after close, leaving time to review flags and publish the hash first.
export const schedule = (closesAt: string) => ({
  closesAt,
  drandRound: roundAt(Date.parse(closesAt) + 30 * 60_000),
});

// Invented brands only.
export const DROPS: Drop[] = [
  {
    id: "kestrel-tidewater",
    brand: "Halden Athletic",
    title: 'Kestrel Runner 01 "Tidewater"',
    colour: "Tidewater",
    priceP: 13500,
    deliveryP: 800,
    currency: "GBP",
    stock: { "UK 4": 4, "UK 5": 8, "UK 6": 10, "UK 7": 10, "UK 8": 6, "UK 9": 2 },
    ...schedule("2026-11-01T18:00:00Z"),
    page: `Halden Athletic: Kestrel Runner 01 "Tidewater"
Colourway: Tidewater (slate blue upper, chalk-white midsole, gum outsole).
Fit: True to size. Medium width; if you are between sizes, take the larger.
Sizes: UK 4 to UK 9.
Price: £135.00. UK delivery: £8.00, tracked, 2 to 3 working days after the draw.
One entry per PayPal account and household. Entering places a hold for the price plus delivery, released if you are not drawn.`,
  },
  {
    id: "marrow-lights-lp",
    brand: "The Marrow Lights",
    title: '"Low Tide Hymns" signed LP',
    colour: "Black vinyl",
    priceP: 3500,
    deliveryP: 450,
    currency: "GBP",
    stock: { LP: 300 },
    ...schedule("2026-11-08T18:00:00Z"),
    page: `The Marrow Lights: "Low Tide Hymns" signed LP
Pressing: 180g heavyweight black vinyl, hand-signed by all four members on the sleeve.
Edition: 300 copies, one format only.
Price: £35.00. UK delivery: £4.50, flat-packed in a rigid mailer.
One entry per PayPal account and household.`,
  },
];

export const findDrop = (id: string) => DROPS.find((d) => d.id === id);
