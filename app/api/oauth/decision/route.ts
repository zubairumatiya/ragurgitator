// ---------------------------------------------------------------------------
// THE CONSENT DECISION — where Approve and Deny actually happen.
//
// The form on /oauth/consent posts here. This route tells Supabase what the user
// chose and forwards the browser to whatever redirect URL comes back, which
// carries either an authorization code or an `access_denied` error for the
// client that started the flow.
//
// requireUserForApi() FIRST, before reading anything from the body. The
// authorization id is a bearer-ish value that arrives over a form post, so the
// session is the only thing proving the person clicking Approve is the person
// the grant will be written for. Supabase scopes the call to the caller's own
// session too, but "the other side also checks" is not a reason to skip it here.
//
// skipBrowserRedirect: true is REQUIRED in a route handler. The default assumes
// a browser context it can navigate; on the server there is nothing to navigate,
// so we ask for the URL and issue the redirect ourselves.
//
// A DENIAL IS A NORMAL OUTCOME, not an error: it still produces a redirect_url,
// because the waiting OAuth client needs to be told no rather than left hanging
// on a request that never resolves.
// ---------------------------------------------------------------------------
import { redirect } from "next/navigation";

import { requireUserForApi, unauthorizedJson } from "@/lib/auth/dal";
import { serverSupabase } from "@/lib/auth/supabase";

export async function POST(request: Request) {
  const user = await requireUserForApi();
  if (!user) return unauthorizedJson();

  const form = await request.formData();
  const authorizationId = form.get("authorization_id")?.toString() ?? "";
  const decision = form.get("decision")?.toString() ?? "";

  if (!authorizationId) {
    return Response.json({ error: "Missing authorization id." }, { status: 400 });
  }
  // Anything that is not exactly "approve" is not an approval. Defaulting the
  // other way — treating an unrecognised value as consent — is the failure mode
  // worth designing against.
  if (decision !== "approve" && decision !== "deny") {
    return Response.json({ error: "Unknown decision." }, { status: 400 });
  }

  const supabase = await serverSupabase();
  const { data, error } =
    decision === "approve"
      ? await supabase.auth.oauth.approveAuthorization(authorizationId, {
          skipBrowserRedirect: true,
        })
      : await supabase.auth.oauth.denyAuthorization(authorizationId, {
          skipBrowserRedirect: true,
        });

  if (error || !data?.redirect_url) {
    const message = error?.message ?? "That authorization request is no longer valid.";
    return Response.json({ error: message }, { status: 400 });
  }

  // Absolute, and off-origin by design — it goes back to the OAuth client's own
  // callback (for a local agent, typically its loopback listener).
  redirect(data.redirect_url);
}
