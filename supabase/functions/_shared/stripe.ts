// Minimal Stripe REST helper. We use raw fetch instead of the SDK for Deno simplicity.

const STRIPE_API = "https://api.stripe.com/v1";

async function gs<T>(token: string, path: string, params: Record<string, string> = {}): Promise<T> {
  const qs = new URLSearchParams(params).toString();
  const url = `${STRIPE_API}${path}${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Stripe ${res.status} on ${path}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

export interface StripeListResponse<T> {
  object: "list";
  data: T[];
  has_more: boolean;
}

export interface StripeCustomer {
  id: string;
  email: string | null;
  name: string | null;
  created: number;
  metadata: Record<string, string>;
}

export interface StripeSubscription {
  id: string;
  customer: string;
  status: string;
  current_period_start: number;
  current_period_end: number;
  canceled_at: number | null;
  start_date: number;
  items: {
    data: Array<{
      price: {
        unit_amount: number | null;
        currency: string;
        recurring: { interval: string } | null;
        nickname: string | null;
        product: string;
      };
      quantity: number;
    }>;
  };
}

export interface StripeInvoice {
  id: string;
  customer: string | null;
  status: string;
  amount_paid: number;
  amount_due: number;
  currency: string;
  status_transitions: { paid_at: number | null };
  created: number;
}

export interface StripeCharge {
  id: string;
  amount: number;
  amount_refunded: number;
  currency: string;
  customer: string | null;
  status: string;
  refunded: boolean;
  invoice: string | null;
  created: number;
}

async function listAll<T>(
  token: string,
  path: string,
  hardLimit = 500,
  extraParams: Record<string, string> = {},
): Promise<T[]> {
  const out: T[] = [];
  let startingAfter: string | undefined;
  while (out.length < hardLimit) {
    const params: Record<string, string> = { limit: "100", ...extraParams };
    if (startingAfter) params.starting_after = startingAfter;
    const page = await gs<StripeListResponse<T & { id: string }>>(token, path, params);
    out.push(...(page.data as T[]));
    if (!page.has_more || page.data.length === 0) break;
    startingAfter = (page.data[page.data.length - 1] as { id: string }).id;
  }
  return out;
}

export async function listCustomers(token: string) {
  return listAll<StripeCustomer>(token, "/customers");
}
export async function listSubscriptions(token: string) {
  // status=all so we capture canceled/past_due too; MRR calc filters active ones.
  return listAll<StripeSubscription>(token, "/subscriptions", 500, { status: "all" });
}
export async function listInvoices(token: string) {
  return listAll<StripeInvoice>(token, "/invoices");
}
export async function listCharges(token: string) {
  return listAll<StripeCharge>(token, "/charges");
}

export interface StripeBalanceTransaction {
  id: string;
  amount: number; // gross, in cents (can be negative for payouts/refunds)
  fee: number; // cents
  net: number; // cents
  currency: string;
  type: string; // charge | payout | refund | topup | transfer | adjustment | ...
  reporting_category: string | null;
  description: string | null;
  status: string; // available | pending
  created: number;
  available_on: number;
  source: string | null;
}

export async function listBalanceTransactions(token: string, limit = 200) {
  return listAll<StripeBalanceTransaction>(token, "/balance_transactions", limit);
}

// --- Write operations (require non read-only key) ----------------------------
async function gsPost<T>(token: string, path: string, form: Record<string, string>): Promise<T> {
  const body = new URLSearchParams(form).toString();
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* keep text */
  }
  if (!res.ok) {
    const detail =
      typeof parsed === "object" && parsed
        ? (parsed as { error?: { message?: string } }).error?.message ?? text
        : text;
    throw new Error(`Stripe ${res.status} on ${path}: ${String(detail).slice(0, 200)}`);
  }
  return parsed as T;
}

export interface StripeRefund {
  id: string;
  amount: number;
  charge: string;
  status: string;
}

export async function refundCharge(
  token: string,
  chargeId: string,
  amountCents?: number,
): Promise<StripeRefund> {
  const form: Record<string, string> = { charge: chargeId };
  if (amountCents) form.amount = String(amountCents);
  return gsPost<StripeRefund>(token, "/refunds", form);
}

export async function refundInvoice(
  token: string,
  invoiceId: string,
): Promise<StripeRefund> {
  // Fetch invoice to get the latest charge, then refund it
  const inv = await gs<{ charge: string | null }>(token, `/invoices/${invoiceId}`);
  if (!inv.charge) throw new Error("Invoice has no associated charge to refund");
  return refundCharge(token, inv.charge);
}

export async function cancelSubscription(token: string, subscriptionId: string) {
  const res = await fetch(`${STRIPE_API}/subscriptions/${subscriptionId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Stripe DELETE /subscriptions/${subscriptionId}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

export async function createCoupon(
  token: string,
  opts: { percent_off?: number; amount_off?: number; currency?: string; duration?: string; id?: string },
): Promise<{ id: string }> {
  const form: Record<string, string> = { duration: opts.duration ?? "once" };
  if (opts.percent_off) form.percent_off = String(opts.percent_off);
  if (opts.amount_off) {
    form.amount_off = String(opts.amount_off);
    form.currency = opts.currency ?? "eur";
  }
  if (opts.id) form.id = opts.id;
  return gsPost<{ id: string }>(token, "/coupons", form);
}
