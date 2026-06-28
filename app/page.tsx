// Root entry: there's no global view anymore — everything is scoped to a config
// tab. Redirect to the first open config (the leftmost tab), falling back to any
// saved config. After the 0011 backfill there is always at least a Default config.
import { redirect } from "next/navigation";
import { listClosedConfigs, listConfigs } from "@/lib/rag/configStore";

// Resolve the redirect per request (not frozen at build): the first open tab
// changes as configs are created/closed, and this avoids a build-time DB hit.
export const dynamic = "force-dynamic";

export default async function Home() {
  const open = await listConfigs();
  const target = open[0] ?? (await listClosedConfigs())[0];
  if (!target) {
    throw new Error(
      "No config exists. Apply migrations 0010/0011 (they backfill a Default config).",
    );
  }
  redirect(`/c/${target.id}`);
}
