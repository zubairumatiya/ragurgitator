// API route: POST /api/demo/start — mint a guest workspace and sign into it.
//
// THE ONE UNAUTHENTICATED WRITE IN THE APP, and it has to be: its whole purpose
// is to serve someone who has no account. What stands in for a session is the
// pair of caps in lib/demo — a per-address provisioning limit and a live-guest
// ceiling — both checked before anything is created. scripts/guards.ts names
// this handler as exempt with that reasoning attached, so the exemption is a
// decision on the record rather than a gap.
//
// WHY IT IS THE ONLY PLACE THAT WRITES A GUEST SESSION. provisionGuest() returns
// credentials and touches no cookies, so the mint and the sign-in stay separable
// (one is testable without a request; the other is three lines). Route handlers
// CAN set cookies, which Server Components cannot — this is why the entry point
// is a route rather than a Server Action on a page.
import { serverSupabase } from "@/lib/auth/supabase";
import { demoEnabled } from "@/lib/demo/config";
import { provisionGuest } from "@/lib/demo/provision";
import { clientAddress } from "@/lib/demo/rateLimit";

// Provisioning does real work — a Voyage verify, a Key Vault wrap, then a clone
// of every chunk in the corpus — so it needs more than the default budget. It is
// still seconds, not minutes: the clone is pure SQL and moves no vectors over
// the wire.
export const maxDuration = 60;

export async function POST(request: Request) {
  // A deployment that has not configured the demo does not have one. 404 rather
  // than 503: there is nothing here to come back for.
  if (!demoEnabled()) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }

  const result = await provisionGuest(clientAddress(request));
  if (!result.ok) {
    return Response.json({ error: result.message }, { status: result.retryable ? 503 : 429 });
  }

  // Signing in with the password we just minted is what turns the account into a
  // session. The password is used once, here, and stored nowhere — it exists for
  // the length of this request and then only inside Supabase's hash.
  const supabase = await serverSupabase();
  const { error } = await supabase.auth.signInWithPassword({
    email: result.email,
    password: result.password,
  });

  if (error) {
    // The workspace exists and will be reaped on schedule; what failed is only
    // the visitor's way into it, so say so plainly rather than pretending the
    // demo is full.
    console.error(`[demo] sign-in for a freshly minted guest failed: ${error.message}`);
    return Response.json(
      { error: "Something went wrong signing you in. Try again in a moment." },
      { status: 500 },
    );
  }

  return Response.json({
    redirect: `/c/${result.clone.configId}`,
    expiresAt: result.expiresAt,
  });
}
