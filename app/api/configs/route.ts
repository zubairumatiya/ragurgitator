// ---------------------------------------------------------------------------
// API route: GET/POST /api/configs
//
// GET returns the tabs the ConfigTabs bar renders: `open` (current tabs, ordered)
// and `closed` (the reopen menu). POST creates a brand-new EMPTY config — a fresh
// corpus + a config seeded with the lib/config.ts defaults — for the "+" button,
// and returns it so the client can route to the new tab.
//
// These act ON the configs table itself rather than within one config's scope, so
// they don't use withRequestConfig (configStore takes explicit ids). Body for
// POST is optional: { name?: string }.
// ---------------------------------------------------------------------------
import { readJsonBody } from "@/lib/http/body";
import { createEmptyConfig, listClosedConfigs, listConfigs } from "@/lib/rag/configStore";

export async function GET() {
  try {
    const [open, closed] = await Promise.all([listConfigs(), listClosedConfigs()]);
    return Response.json({ open, closed });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list configs.";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  // An empty body is fine — the "+" button sends none. Only read a name if given;
  // readJsonBody never throws, it returns a 400-ready response we simply ignore.
  let name: string | undefined;
  const raw = await readJsonBody(request);
  if (raw.data && typeof raw.data === "object") {
    const candidate = (raw.data as { name?: unknown }).name;
    if (typeof candidate === "string") name = candidate;
  }

  try {
    const created = await createEmptyConfig(name);
    return Response.json({ config: created }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create config.";
    return Response.json({ error: message }, { status: 500 });
  }
}
