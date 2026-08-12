// API route: PATCH/POST/DELETE /api/configs/[id]
//
//   PATCH  — mutate one tab: { name } rename, { isOpen } close/reopen,
//            { tabOrder } move, { corpusSync } toggle corpus auto-sync (0017),
//            { llmModel } set the answer-generation model (§9.2).
//            Mixed bodies apply each field present.
//   POST   — duplicate this config (copy-on-write, no embedding calls); returns
//            the new config. POST-to-a-resource = "make a copy of it".
//   DELETE — permanently delete this config and the data it owns.
//
// configStore takes explicit ids, so these don't need withRequestConfig. The last
// open tab can't be closed and the last config can't be deleted — the UI always
// needs somewhere to land. `params` is a Promise in this Next.js version.
import { readJsonBody } from "@/lib/http/body";
import { withRequestUser } from "@/lib/http/configScope";
import { LLM_MODELS } from "@/lib/llm/llmModels";
import {
  closeConfig,
  countConfigs,
  countOpenConfigs,
  deleteConfig,
  duplicateConfig,
  renameConfig,
  reopenConfig,
  setCorpusSync,
  setLlmModel,
  setTabOrder,
} from "@/lib/rag/configStore";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withRequestUser(async () => {
    const { id } = await params;
    const raw = await readJsonBody(request);
    if (raw.response) return raw.response;
    const body = (raw.data ?? {}) as {
      name?: unknown;
      isOpen?: unknown;
      tabOrder?: unknown;
      corpusSync?: unknown;
      llmModel?: unknown;
    };

    try {
      let touched = false;

      if (typeof body.corpusSync === "boolean") {
        if (!(await setCorpusSync(id, body.corpusSync))) {
          return Response.json({ error: "Config not found." }, { status: 404 });
        }
        touched = true;
      }

      if (typeof body.name === "string") {
        if (!(await renameConfig(id, body.name))) {
          return Response.json({ error: "Config not found." }, { status: 404 });
        }
        touched = true;
      }

      // The Settings dropdown's LLM picker (§9.2). Validated through llmSpec()
      // HERE rather than in the store, because this is the closest point to the
      // control that set it: an unknown llm_model otherwise surfaces as a thrown
      // error deep inside a generation call, three screens away, long after the
      // dropdown that caused it has closed. llmSpec throws on an unknown id, so
      // the catch below would turn a bad id into a 500 — hence the explicit
      // membership test and 400.
      if (typeof body.llmModel === "string") {
        if (!(body.llmModel in LLM_MODELS)) {
          return Response.json(
            { error: `Unknown LLM model "${body.llmModel}".` },
            { status: 400 },
          );
        }
        if (!(await setLlmModel(id, body.llmModel))) {
          return Response.json({ error: "Config not found." }, { status: 404 });
        }
        touched = true;
      }

      if (typeof body.tabOrder === "number") {
        if (!(await setTabOrder(id, body.tabOrder))) {
          return Response.json({ error: "Config not found." }, { status: 404 });
        }
        touched = true;
      }

      if (typeof body.isOpen === "boolean") {
        if (body.isOpen) {
          if (!(await reopenConfig(id))) {
            return Response.json({ error: "Config not found." }, { status: 404 });
          }
        } else {
          // Refuse to close the last open tab — there'd be no tab to fall back to.
          if ((await countOpenConfigs()) <= 1) {
            return Response.json(
              { error: "Can't close the last open tab." },
              { status: 400 },
            );
          }
          if (!(await closeConfig(id))) {
            return Response.json({ error: "Config not found." }, { status: 404 });
          }
        }
        touched = true;
      }

      if (!touched) {
        return Response.json(
          {
            error:
              "Nothing to update — send name, isOpen, tabOrder, corpusSync, or llmModel.",
          },
          { status: 400 },
        );
      }
      return Response.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update config.";
      return Response.json({ error: message }, { status: 500 });
    }
  });
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withRequestUser(async () => {
    const { id } = await params;
    try {
      const created = await duplicateConfig(id);
      if (!created) return Response.json({ error: "Config not found." }, { status: 404 });
      return Response.json({ config: created }, { status: 201 });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to duplicate config.";
      return Response.json({ error: message }, { status: 500 });
    }
  });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withRequestUser(async () => {
    const { id } = await params;
    try {
      // Never delete the final config — the app needs at least one to render.
      if ((await countConfigs()) <= 1) {
        return Response.json({ error: "Can't delete the last config." }, { status: 400 });
      }
      const deleted = await deleteConfig(id);
      if (!deleted) return Response.json({ error: "Config not found." }, { status: 404 });
      return Response.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to delete config.";
      return Response.json({ error: message }, { status: 500 });
    }
  });
}
