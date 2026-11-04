/**
 * Stackd — Stripe webhook.
 *
 * This is the ONLY thing that grants or removes Pro. The browser has no
 * UPDATE privilege on profiles.plan, and neither checkout function sets it:
 * access follows Stripe's view of the subscription, so a user who stops
 * paying loses access without anyone intervening, and one who pays gets it
 * even if they close the tab before being redirected back.
 *
 * Runs with verify_jwt = false, because Stripe has no Supabase token. The
 * signature check below is what authenticates the caller, and nothing in the
 * request is trusted until it passes.
 *
 * Secrets:
 *   STRIPE_SECRET_KEY
 *   STRIPE_WEBHOOK_SECRET   whsec_... from the endpoint's page in Stripe
 */

import Stripe from "npm:stripe@17.7.0";
import { createClient } from "npm:@supabase/supabase-js@2.49.4";

/* Which Stripe states count as paid access.
   past_due is deliberately included: the card failed but Stripe is still
   retrying, and cutting someone off mid-dunning over a temporary decline is
   both hostile and usually wrong. Access ends when Stripe gives up and the
   subscription actually becomes canceled or unpaid. */
const PAID = new Set(["active", "trialing", "past_due"]);

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY");
  const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET) {
    console.error("webhook called before secrets were configured");
    return new Response("Not configured", { status: 503 });
  }

  const stripe = new Stripe(STRIPE_SECRET_KEY, {
    httpClient: Stripe.createFetchHttpClient(),
  });

  const signature = req.headers.get("stripe-signature");
  if (!signature) return new Response("Missing signature", { status: 400 });

  // The raw body is required — any reserialization changes the bytes and the
  // signature no longer matches.
  const raw = await req.text();

  let event: Stripe.Event;
  try {
    // Async variant: Deno's SubtleCrypto has no synchronous digest.
    event = await stripe.webhooks.constructEventAsync(
      raw,
      signature,
      STRIPE_WEBHOOK_SECRET,
      undefined,
      Stripe.createSubtleCryptoProvider(),
    );
  } catch (e) {
    /* An invalid signature means this did not come from Stripe. Refuse it
       rather than reading anything out of the body. */
    console.error("signature verification failed:", (e as Error).message);
    return new Response("Invalid signature", { status: 400 });
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  /* Find the account a subscription belongs to. The metadata we set at
     checkout is the primary link; the customer id is the fallback for events
     that originate in the Stripe dashboard, where that metadata won't exist. */
  async function resolveUserId(sub: Stripe.Subscription): Promise<string | null> {
    const fromMeta = sub.metadata?.supabase_user_id;
    if (fromMeta) return fromMeta;

    const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
    if (!customerId) return null;

    const { data } = await admin
      .from("profiles").select("id").eq("stripe_customer_id", customerId).maybeSingle();
    if (data?.id) return data.id;

    // Last resort: the customer record itself carries the id we set on create.
    try {
      const customer = await stripe.customers.retrieve(customerId);
      if (!("deleted" in customer)) {
        return (customer.metadata?.supabase_user_id as string) ?? null;
      }
    } catch { /* fall through */ }
    return null;
  }

  async function applySubscription(sub: Stripe.Subscription) {
    const userId = await resolveUserId(sub);
    if (!userId) {
      console.error("could not map subscription to a user:", sub.id);
      return;
    }
    const paid = PAID.has(sub.status);
    const periodEnd = (sub as unknown as { current_period_end?: number }).current_period_end;

    const { error } = await admin.from("profiles").update({
      plan: paid ? "pro" : "free",
      subscription_status: sub.status,
      /* Stripe keeps a cancelled subscription active until the paid period
         ends. Without this the app would promise a renewal that isn't
         coming. */
      cancel_at_period_end: sub.cancel_at_period_end === true,
      stripe_subscription_id: sub.id,
      stripe_customer_id: typeof sub.customer === "string" ? sub.customer : sub.customer?.id,
      current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    }).eq("id", userId);

    if (error) console.error("profile update failed:", error.message);
    else console.log(`${sub.status} → ${paid ? "pro" : "free"} for ${userId}`);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.mode !== "subscription" || !session.subscription) break;
        const subId = typeof session.subscription === "string"
          ? session.subscription : session.subscription.id;
        /* Re-fetch rather than trusting the embedded copy: the session object
           may predate the subscription's final state. */
        const sub = await stripe.subscriptions.retrieve(subId);
        if (!sub.metadata?.supabase_user_id && session.client_reference_id) {
          sub.metadata = { ...sub.metadata, supabase_user_id: session.client_reference_id };
        }
        await applySubscription(sub);
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
      case "customer.subscription.paused":
      case "customer.subscription.resumed":
        await applySubscription(event.data.object as Stripe.Subscription);
        break;

      default:
        // Everything else is acknowledged and ignored, so Stripe stops retrying.
        break;
    }
  } catch (e) {
    /* A 500 makes Stripe retry, which is what we want for a transient failure
       — the events are idempotent, so replaying one is harmless. */
    console.error("handler failed:", e);
    return new Response("Handler error", { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" },
  });
});
