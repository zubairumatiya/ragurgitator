// Evicting every OTHER device after a password change.
//
// A password change that leaves existing sessions alive is close to cosmetic. The
// two reasons anyone changes a password are "I think someone has my account" and
// "I am tidying up", and the first one is only served if the intruder's refresh
// token stops working. Without this, they keep the account until their token
// expires on its own schedule.
//
// scope "others", never "global": the user who just did the work stays signed in
// on the device they did it from. Signing them out too reads as an error, and
// sends them back to a login form to retype the password they set five seconds
// ago.
import type { SupabaseClient } from "@supabase/supabase-js";

export async function revokeOtherSessions(supabase: SupabaseClient): Promise<void> {
  const { error } = await supabase.auth.signOut({ scope: "others" });
  // Reported, not thrown. The password IS already changed by the time this runs,
  // so failing the action here would tell the user their change did not happen
  // when it did — and send them to retry with a password that is now the old one.
  if (error) {
    console.error("failed to revoke other sessions after a password change", error);
  }
}
