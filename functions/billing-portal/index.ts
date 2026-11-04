/**
 * Stackd — open the Stripe billing portal.
 *
 * Stripe hosts the portal, so cancelling, changing a card, downloading
 * invoices and reactivating are all handled there rather than being rebuilt
 * here. That also keeps card details entirely outside this app.
 *
 * Secrets:
 *   STRIPE_SECRET_KEY
 *   SITE_URL
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
  const SITE_URL = Deno.env.get("SITE_URL") ?? "https://stackdpicks.com";
  if (!STRIPE_SECRET_KEY) return json({ error: "Billing is not configured yet." }, 503);

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const authClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error: userErr } = await authClient.auth.getUser();
    if (userErr || !user) return json({ error: "Not signed in." }, 401);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: profile } = await admin
      .from("profiles")
      .select("stripe_customer_id")
      .eq("id", user.id)
      .single();

    /* No customer record means this account has never been through checkout.
       Stripe would reject the portal call, so answer plainly instead. */
    if (!profile?.stripe_customer_id) {
      return json({ error: "No billing history for this account yet." }, 404);
    }

    const stripe = new Stripe(STRIPE_SECRET_KEY, {
      httpClient: Stripe.createFetchHttpClient(),
    });

    const session = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: SITE_URL,
    });

    return json({ url: session.url });
  } catch (e) {
    console.error("billing-portal failed:", e);
    return json({ error: "Could not open the billing portal. Please try again." }, 500);
  }
});
