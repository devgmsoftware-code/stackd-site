/**
 * Stackd — Stripe webhook.
 *
 * The ONLY thing that grants or removes Pro, and the only thing that pays or
 * reverses a referral. The browser has no UPDATE privilege on profiles.plan,
 * referred_by, referral_credit_months or referral_months_earned.
 *
 * verify_jwt = false because Stripe has no Supabase token. The signature
 * check authenticates the caller; nothing in the body is read until it
 * passes.
 *
 * EVENTS THIS FUNCTION NEEDS SUBSCRIBED (all ten — the last four ARE the
 * referral program; without invoice.payment_succeeded no referral ever pays,
 * and without the charge.* pair a chargeback keeps its reward):
 *   checkout.session.completed
 *   checkout.session.expired
 *   customer.subscription.created
 *   customer.subscription.updated
 *   customer.subscription.deleted
 *   customer.subscription.paused
 *   customer.subscription.resumed
 *   invoice.payment_succeeded
 *   charge.refunded
 *   charge.dispute.created
 */

import Stripe from "npm:stripe@17.7.0";
import { createClient } from "npm:@supabase/supabase-js@2.49.4";

/* past_due counts as paid: the card failed but Stripe is still retrying, and
   cutting someone off mid-dunning over a temporary decline is both hostile
   and usually wrong. Access ends when Stripe gives up. */
const PAID = new Set(["active", "trialing", "past_due"]);

// One-time welcome credit for someone who arrived through an invite link.
const FRIEND_CREDIT_CENTS = 500;

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY");
  const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  const STRIPE_PRICE_ID = Deno.env.get("STRIPE_PRICE_ID");
  if (!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET) {
    console.error("webhook called before secrets were configured");
    return new Response("Not configured", { status: 503 });
  }

  const stripe = new Stripe(STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });

  const signature = req.headers.get("stripe-signature");
  if (!signature) return new Response("Missing signature", { status: 400 });

  const raw = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      raw, signature, STRIPE_WEBHOOK_SECRET, undefined, Stripe.createSubtleCryptoProvider(),
    );
  } catch (e) {
    console.error("signature verification failed:", (e as Error).message);
    return new Response("Invalid signature", { status: 400 });
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  async function resolveUserId(sub: Stripe.Subscription): Promise<string | null> {
    const fromMeta = sub.metadata?.supabase_user_id;
    if (fromMeta) return fromMeta;
    const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
    if (!customerId) return null;
    const { data } = await admin
      .from("profiles").select("id").eq("stripe_customer_id", customerId).maybeSingle();
    if (data?.id) return data.id;
    try {
      const customer = await stripe.customers.retrieve(customerId);
      if (!("deleted" in customer)) return (customer.metadata?.supabase_user_id as string) ?? null;
    } catch { /* fall through */ }
    return null;
  }

  async function applySubscription(sub: Stripe.Subscription) {
    const userId = await resolveUserId(sub);
    if (!userId) { console.error("could not map subscription to a user:", sub.id); return; }
    const paid = PAID.has(sub.status);
    const periodEnd = (sub as unknown as { current_period_end?: number }).current_period_end;

    const { error } = await admin.from("profiles").update({
      plan: paid ? "pro" : "free",
      subscription_status: sub.status,
      cancel_at_period_end: sub.cancel_at_period_end === true,
      stripe_subscription_id: sub.id,
      stripe_customer_id: typeof sub.customer === "string" ? sub.customer : sub.customer?.id,
      current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    }).eq("id", userId);

    if (error) console.error("profile update failed:", error.message);
    else console.log(`${sub.status} -> ${paid ? "pro" : "free"} for ${userId}`);
  }

  /* A month at the real list price rather than a number hardcoded here — if
     the price changes, the reward changes with it. */
  async function monthlyAmount(): Promise<{ amount: number; currency: string } | null> {
    if (!STRIPE_PRICE_ID) return null;
    try {
      const price = await stripe.prices.retrieve(STRIPE_PRICE_ID);
      if (!price.unit_amount) return null;
      return { amount: price.unit_amount, currency: price.currency };
    } catch (e) {
      console.error("could not read price:", e);
      return null;
    }
  }

  async function customerCredit(customerId: string, cents: number, currency: string, why: string) {
    // Negative moves the balance in the customer's favour.
    await stripe.customers.createBalanceTransaction(customerId, {
      amount: -Math.abs(cents), currency, description: why,
    });
  }

  async function grantFreeMonth(referrerId: string) {
    /* The database holds the cap, so this returns what was actually granted —
       zero once the lifetime limit is reached. */
    const { data: granted } = await admin.rpc("add_referral_credit", {
      p_user: referrerId, p_months: 1,
    });
    if (!Number(granted)) {
      console.log(`referrer ${referrerId} is at the lifetime cap; nothing granted`);
      return;
    }

    const { data: ref } = await admin.from("profiles")
      .select("stripe_customer_id, plan").eq("id", referrerId).maybeSingle();

    /* Someone already subscribed can't use a free month as a trial, so turn
       it into account credit now. Spend only AFTER Stripe confirms, so a
       failure leaves the month banked rather than silently lost. */
    if (ref?.stripe_customer_id && ref.plan === "pro") {
      const price = await monthlyAmount();
      if (price) {
        try {
          await customerCredit(ref.stripe_customer_id, price.amount, price.currency,
            "Referral reward - one month free");
          await admin.rpc("spend_referral_credit", { p_user: referrerId, p_months: 1 });
          console.log(`referral month applied in Stripe for ${referrerId}`);
        } catch (e) {
          console.error("balance credit failed, leaving it banked:", e);
        }
      }
    }
  }

  /* The other side of the referral: whoever used the link gets a one-time
     welcome credit against their next invoice. */
  async function creditReferredFriend(referredId: string) {
    const { data: p } = await admin.from("profiles")
      .select("stripe_customer_id").eq("id", referredId).maybeSingle();
    if (!p?.stripe_customer_id) return;
    const price = await monthlyAmount();
    try {
      await customerCredit(p.stripe_customer_id, FRIEND_CREDIT_CENTS,
        price?.currency ?? "usd", "Welcome credit - joined through a referral");
      console.log(`friend credit applied for ${referredId}`);
    } catch (e) {
      console.error("friend credit failed:", e);
    }
  }

  /* Settles a pending referral exactly once. The status filter is what makes
     this safe under replays: a second attempt updates zero rows and pays
     nothing. */
  async function qualifyReferral(referredId: string) {
    const { data: rows, error } = await admin
      .from("referrals")
      .update({ status: "qualified", qualified_at: new Date().toISOString() })
      .eq("referred_id", referredId)
      .eq("status", "pending")
      .select("referrer_id");

    if (error) { console.error("referral settle failed:", error.message); return; }
    if (!rows || rows.length === 0) return;

    console.log(`referral qualified: ${referredId} -> ${rows[0].referrer_id}`);
    await grantFreeMonth(rows[0].referrer_id);
    await creditReferredFriend(referredId);
  }

  /* A refund or a dispute means the payment that earned the reward did not
     stand. Void the referral and take the month back — from the banked
     balance if it's still there, otherwise by reversing the Stripe credit. */
  async function clawback(customerId: string, why: string) {
    const { data: payer } = await admin.from("profiles")
      .select("id").eq("stripe_customer_id", customerId).maybeSingle();
    if (!payer) return;

    const { data: rows, error } = await admin
      .from("referrals")
      .update({ status: "void" })
      .eq("referred_id", payer.id)
      .eq("status", "qualified")
      .select("referrer_id");
    if (error) { console.error("referral void failed:", error.message); return; }
    if (!rows || rows.length === 0) return;

    const referrerId = rows[0].referrer_id;
    const { data: shortfall } = await admin.rpc("revoke_referral_credit", {
      p_user: referrerId, p_months: 1,
    });

    console.log(`referral voided (${why}) for ${payer.id}; shortfall ${shortfall}`);

    /* Nothing banked to take back means it was already applied in Stripe, so
       reverse it there. A positive amount moves the balance against them. */
    if (Number(shortfall) > 0) {
      const { data: ref } = await admin.from("profiles")
        .select("stripe_customer_id").eq("id", referrerId).maybeSingle();
      const price = await monthlyAmount();
      if (ref?.stripe_customer_id && price) {
        try {
          await stripe.customers.createBalanceTransaction(ref.stripe_customer_id, {
            amount: price.amount * Number(shortfall),
            currency: price.currency,
            description: "Referral reversed - referred payment did not stand",
          });
        } catch (e) {
          console.error("could not reverse referral credit in Stripe:", e);
        }
      }
    }
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.mode !== "subscription" || !session.subscription) break;
        const subId = typeof session.subscription === "string"
          ? session.subscription : session.subscription.id;
        const sub = await stripe.subscriptions.retrieve(subId);
        if (!sub.metadata?.supabase_user_id && session.client_reference_id) {
          sub.metadata = { ...sub.metadata, supabase_user_id: session.client_reference_id };
        }
        await applySubscription(sub);
        break;
      }

      case "checkout.session.expired": {
        /* Credit is spent when the session is created so two tabs can't claim
           the same month. If it is never completed, give it back. */
        const session = event.data.object as Stripe.Checkout.Session;
        const months = Number(session.metadata?.referral_months_applied ?? 0);
        const userId = session.metadata?.supabase_user_id ?? session.client_reference_id;
        if (months > 0 && userId) {
          await admin.rpc("add_referral_credit", { p_user: userId, p_months: months });
          console.log(`returned ${months} month(s) to ${userId} after an abandoned checkout`);
        }
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
      case "customer.subscription.paused":
      case "customer.subscription.resumed":
        await applySubscription(event.data.object as Stripe.Subscription);
        break;

      case "invoice.payment_succeeded": {
        const inv = event.data.object as Stripe.Invoice;
        /* Money actually arrived. Deliberately the trigger rather than the
           subscription merely becoming active: a trial, or a card authorised
           then reversed, would otherwise earn a real reward. */
        if (inv.billing_reason !== "subscription_create") break;
        if ((inv.amount_paid ?? 0) <= 0) break;
        const customerId = typeof inv.customer === "string" ? inv.customer : inv.customer?.id;
        if (!customerId) break;
        const { data: payer } = await admin.from("profiles")
          .select("id").eq("stripe_customer_id", customerId).maybeSingle();
        if (!payer) break;
        await qualifyReferral(payer.id);
        break;
      }

      case "charge.refunded": {
        const charge = event.data.object as Stripe.Charge;
        const customerId = typeof charge.customer === "string" ? charge.customer : charge.customer?.id;
        if (customerId) await clawback(customerId, "refund");
        break;
      }

      case "charge.dispute.created": {
        const dispute = event.data.object as Stripe.Dispute;
        const chargeId = typeof dispute.charge === "string" ? dispute.charge : dispute.charge?.id;
        if (!chargeId) break;
        try {
          const charge = await stripe.charges.retrieve(chargeId);
          const customerId = typeof charge.customer === "string" ? charge.customer : charge.customer?.id;
          if (customerId) await clawback(customerId, "dispute");
        } catch (e) {
          console.error("could not read disputed charge:", e);
        }
        break;
      }

      default:
        break;
    }
  } catch (e) {
    /* 500 makes Stripe retry, which is right for a transient failure: every
       handler above is idempotent, so a replay is harmless. */
    console.error("handler failed:", e);
    return new Response("Handler error", { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" },
  });
});
