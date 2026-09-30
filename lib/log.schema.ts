// The shape of one line from lib/log.ts. The unit test parses every line it
// captures against this, so a change to the envelope has to change here too.
import { z } from "zod";

export const logLineSchema = z.looseObject({
  t: z.iso.datetime(),
  level: z.enum(["debug", "info", "warn", "error"]),
  msg: z.string(),
  requestId: z.string().regex(/^\S+$/).optional(),
  route: z.string().optional(),
  userId: z.string().optional(),
  guest: z.boolean().optional(),
  configId: z.string().optional(),
  jobId: z.string().optional(),
});

export type LogLine = z.infer<typeof logLineSchema>;
