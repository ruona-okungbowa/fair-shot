// Minimal PayPal REST client. Server-only: reads the client secret from env.

const BASE = process.env.PAYPAL_BASE ?? "https://api-m.sandbox.paypal.com";

// shortcut: fetches a fresh OAuth token per call, cache it by expires_in once call volume matters
async function token() {
  const { PAYPAL_CLIENT_ID: id, PAYPAL_CLIENT_SECRET: secret } = process.env;
  if (!id || !secret) throw new Error("PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET not set");
  const basic = Buffer.from(`${id}:${secret}`).toString("base64");
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`PayPal auth ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token as string;
}

// `declined` is true only for a definite no (422, or a hold that came back not CREATED).
// Anything else, like a timeout or a 5xx, may have succeeded at PayPal and must not be treated as a no.
export class PayPalError extends Error {
  declined: boolean;
  constructor(message: string, declined: boolean) {
    super(message);
    this.declined = declined;
  }
}

// PayPal-Request-Id makes the POST idempotent, so a retried hold or capture never doubles up.
async function post(path: string, body: unknown = {}, requestId?: string) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await token()}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(requestId && { "PayPal-Request-Id": requestId }),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new PayPalError(`PayPal ${path} ${res.status}: ${text}`, res.status === 422);
  return text ? JSON.parse(text) : {};
}

// Step 1 of Agent Pass: the buyer approves once at approveUrl.
export async function createSetupToken(returnUrl: string, cancelUrl: string) {
  const t = await post("/v3/vault/setup-tokens", {
    payment_source: {
      paypal: {
        usage_type: "MERCHANT",
        customer_type: "CONSUMER",
        experience_context: { brand_name: "Fair Shot", return_url: returnUrl, cancel_url: cancelUrl },
      },
    },
  });
  const approveUrl = t.links?.find((l: { rel: string }) => l.rel === "approve")?.href as string;
  return { id: t.id as string, approveUrl };
}

// Step 2: swap the approved setup token for a reusable vault id.
export async function createPaymentToken(setupTokenId: string) {
  const t = await post("/v3/vault/payment-tokens", {
    payment_source: { token: { id: setupTokenId, type: "SETUP_TOKEN" } },
  });
  return { vaultId: t.id as string, customerId: t.customer?.id as string };
}

// Places a hold on the vaulted PayPal account with no buyer present.
export async function placeHold(vaultId: string, value: string, currency: string, requestId: string) {
  let order = await post(
    "/v2/checkout/orders",
    {
      intent: "AUTHORIZE",
      purchase_units: [{ amount: { currency_code: currency, value } }],
      payment_source: { paypal: { vault_id: vaultId } },
    },
    requestId,
  );
  // Vaulted orders normally authorize on create; fall back to an explicit authorize if not.
  if (!order.purchase_units?.[0]?.payments?.authorizations) {
    order = await post(`/v2/checkout/orders/${order.id}/authorize`, {}, `${requestId}-auth`);
  }
  const auth = order.purchase_units[0].payments.authorizations[0];
  // Only a live hold counts as an entry; DENIED or PENDING would leave nothing to capture.
  if (auth.status !== "CREATED") throw new PayPalError(`PayPal hold ${auth.id} is ${auth.status}, not CREATED`, true);
  return { orderId: order.id as string, authorizationId: auth.id as string, status: auth.status as string };
}

export const captureHold = (authorizationId: string, requestId: string) =>
  post(`/v2/payments/authorizations/${authorizationId}/capture`, {}, requestId);

export const voidHold = (authorizationId: string) =>
  post(`/v2/payments/authorizations/${authorizationId}/void`);
