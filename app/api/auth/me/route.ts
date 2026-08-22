// Who am I? Backs the sidebar's account footer and the demo banner, both Client
// Components and so unable to call the DAL directly.
//
// Returns the SessionUser DTO plus the two guest fields, and nothing else —
// never the Supabase user object, which carries app_metadata, identities and raw
// provider payloads that have no business reaching the browser.
//
// It enters a request scope now, which it did not before: guestStatus() reads
// the caller's own user_profiles row through the RLS-scoped handle, so that
// "which user is this about" is answered by the transaction's identity rather
// than by an argument anyone could pass.
import { withRequestUser } from "@/lib/http/configScope";
import { getSessionUser } from "@/lib/auth/dal";
import { guestStatus } from "@/lib/demo/guest";

export async function GET() {
  return withRequestUser(async () => {
    // Non-null inside the scope — withRequestUser already 401s without a
    // session — and re-read rather than threaded because React's cache() makes
    // the second call free.
    const user = await getSessionUser();
    const guest = await guestStatus();
    return Response.json({ user, guest });
  });
}
