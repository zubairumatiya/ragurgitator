// Who am I? Backs the sidebar's account footer, which is a Client Component and
// so can't call the DAL directly.
//
// Returns the SessionUser DTO and nothing else — never the Supabase user object,
// which carries app_metadata, identities and raw provider payloads that have no
// business reaching the browser.
import { requireUserForApi, unauthorizedJson } from "@/lib/auth/dal";

export async function GET() {
  const user = await requireUserForApi();
  if (!user) return unauthorizedJson();
  return Response.json({ user });
}
