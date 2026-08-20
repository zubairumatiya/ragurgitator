// The rules a NEW password has to satisfy, and how failures are reported.
//
// A module of its own, not an export from app/auth/actions.ts, because that file
// carries "use server": a Server Actions module may only export async functions, so
// a schema and a plain helper cannot live there and still be importable. Three
// call sites now need these — signup, the reset-link flow, and the change-password
// form on /account — and a second copy of the rules is how they drift apart.
import { z } from "zod";

// Signup and reset hold passwords to a real standard; SIGN-IN deliberately does
// not reuse this. Applying new-password rules at sign-in would reject valid older
// passwords, and worse, the rejection message would tell an attacker which rules a
// password does not satisfy.
export const NewPassword = z
  .string()
  .min(8, "Use at least 8 characters.")
  // bcrypt — which Supabase uses — hashes only the first 72 BYTES and silently
  // ignores the rest. Rejecting here is honest; accepting would mean a password
  // whose tail does nothing.
  .max(72, "Use 72 characters or fewer.")
  .regex(/[a-zA-Z]/, "Include at least one letter.")
  .regex(/[0-9]/, "Include at least one number.");

// The same sentence, wherever a form explains the rules up front rather than
// letting the user discover them by rejection. Kept next to the schema because the
// two must agree — a hint that promises less than NewPassword enforces is worse
// than no hint at all.
export const PASSWORD_HINT = "At least 8 characters, including a letter and a number.";

// Every failing rule at once. Fixing one problem only to be told about the next is
// the worst version of a password form.
export function allIssues(error: z.ZodError): string {
  return [...new Set(error.issues.map((i) => i.message))].join(" ");
}
