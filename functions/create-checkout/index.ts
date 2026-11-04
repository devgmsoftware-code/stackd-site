/**
 * Stackd — create a Stripe Checkout session.
 *
 * Called by the Upgrade button. Returns a URL the browser redirects to.
 *
 * The caller's identity comes from their Supabase JWT, never from the request
 * body: a client that could name its own user id could buy a subscription for
 * somebody else, or worse, claim someone else's.
 *
 * Secrets (Supabase → Edge Functions → Secrets):
 *   STRIPE_SECRET_KEY   sk_test_... while testing, sk_live_... in production
 *   STRIPE_PRICE_ID     price_... for the $9.99/mo recurring price
 *   SITE_URL            https://stackdpicks.com
 */

import Stripe from "npm:stripe@17.7.0";
import { createClient } from "npm:@supabase/supabase-js@2.49.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY");
  const STRIPE_PRICE_ID = Deno.env.get("STRIPE_PRICE_ID");
  const SITE_URL = Deno.env.get("SITE_URL") ?? "https://stackdpicks.com";

  if (!STRIPE_SECRET_KEY || !STRIPE_PRICE_ID) {
    return json({ error: "Billing is not configured yet." }, 503);
  }

  try {
    // Identify the caller from their token. The platform has already checked
    // the signature; this turns it into a user id.
    const authHeader = req.headers.get("Authorization") ?? "";
    const authClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error: userErr } = await authClient.auth.getUser();
    if (userErr || !user) return json({ error: "Not signed in." }, 401);

    // Service role: reads and writes the billing columns the browser can't.
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: profile } = await admin
      .from("profiles")
      .select("stripe_customer_id, plan, email")
      .eq("id", user.id)
      .single();

    if (profile?.plan === "pro") {
      return json({ error: "This account is already on Pro." }, 409);
    }

    const stripe = new Stripe(STRIPE_SECRET_KEY, {
      httpClient: Stripe.createFetchHttpClient(),
    });

    /* Reuse the Stripe customer if we've seen this account before, so a user
       who cancels and resubscribes keeps one billing history rather than
       accumulating duplicate customers. */
    let customerId = profile?.stripe_customer_id ?? null;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email ?? profile?.email ?? undefined,
        metadata: { supabase_user_id: user.id },
      });
      customerId = customer.id;
      await admin.from("profiles").update({ stripe_customer_id: customerId }).eq("id", user.id);
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${SITE_URL}/?checkout=success`,
      cancel_url: `${SITE_URL}/?checkout=cancelled`,
      allow_promotion_codes: true,
      /* Both carried so the webhook can tie the subscription back to the
         account even if the customer record is somehow missing its metadata. */
      client_reference_id: user.id,
      subscription_data: { metadata: { supabase_user_id: user.id } },
      metadata: { supabase_user_id: user.id },
    });

    return json({ url: session.url });
  } catch (e) {
    console.error("create-checkout failed:", e);
    return json({ error: "Could not start checkout. Please try again." }, 500);
  }
});
