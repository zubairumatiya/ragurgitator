// ---------------------------------------------------------------------------
// Shared JSON request-body validation for the API routes. Each route declares
// its payload contract once as a Zod schema; parseBody reads the body and
// validates it in one step, handing back either typed data or a ready-to-return
// 400 Response. Schema `error` messages become the API's error strings, and
// every problem is reported in one response rather than just the first.
//
// readJsonBody/invalidBody are exported separately for routes that need to
// branch on the raw payload before choosing a schema (see questions/[id]/
// rechunk).
// ---------------------------------------------------------------------------
import { z } from "zod";

type Parsed<T> =
  | { data: T; response?: undefined }
  | { data?: undefined; response: Response };

// Read the raw JSON body, or produce the standard 400 for a non-JSON payload.
export async function readJsonBody(request: Request): Promise<Parsed<unknown>> {
  try {
    return { data: await request.json() };
  } catch {
    return {
      response: Response.json({ error: "Expected a JSON body." }, { status: 400 }),
    };
  }
}

// The standard 400 for a payload that parsed as JSON but failed its schema.
// Messages are deduped: an array of bad elements repeats one message per item.
export function invalidBody(error: z.ZodError): Response {
  const message = [...new Set(error.issues.map((issue) => issue.message))].join(" ");
  return Response.json({ error: message }, { status: 400 });
}

export async function parseBody<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<Parsed<T>> {
  const raw = await readJsonBody(request);
  if (raw.response) return raw;
  const result = schema.safeParse(raw.data);
  if (!result.success) return { response: invalidBody(result.error) };
  return { data: result.data };
}

// A required string field that must contain non-whitespace; the value is
// trimmed on the way through. One message covers both wrong-type and empty.
export function requiredTrimmedString(error: string) {
  return z.string({ error }).trim().min(1, { error });
}
