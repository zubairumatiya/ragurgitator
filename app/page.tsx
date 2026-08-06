// Root entry: there's no global view anymore — everything is scoped to a config
// tab. Redirect to the first open config (the leftmost tab), falling back to any
// saved config. After the 0011 backfill there is always at least a Default config.
import { redirect } from "next/navigation";
import { withPageUser } from "@/lib/auth/dal";
import {
  createEmptyConfig,
  listClosedConfigs,
  listConfigs,
} from "@/lib/rag/configStore";

// Resolve the redirect per request (not frozen at build): the first open tab
// changes as configs are created/closed, and this avoids a build-time DB hit.
export const dynamic = "force-dynamic";

export default async function Home() {
  // redirect() throws internally, so it must run OUTSIDE withPageUser — doing the
  // navigation after the scope closes keeps "what we read" and "where we go"
  // separate, and avoids unwinding a redirect through the ALS scope.
  const targetId = await withPageUser(async () => {
    const open = await listConfigs();
    const existing = open[0] ?? (await listClosedConfigs())[0];
    if (existing) return existing.id;

    // A brand-new account owns no configs. Before ownership this was
    // unreachable — the 0011 backfill guaranteed a Default config — but every
    // page below now assumes the user has at least one, and the "+ New tab"
    // button that would create one lives INSIDE the config layout, which needs a
    // config to render. So seed the same corpus-less starter config the "+"
    // button makes, rather than stranding the account on an empty shell.
    const seeded = await createEmptyConfig("Default");
    return seeded.id;
  });

  redirect(`/c/${targetId}`);
}
