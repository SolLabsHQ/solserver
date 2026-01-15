import { z } from "zod";

export const OutputEnvelope = z.object({
  assistant_text: z.string().min(1),
  assumptions: z.array(z.string()).optional(),
  unknowns: z.array(z.string()).optional(),
  used_context_ids: z.array(z.string()).optional(),
  meta: z.record(z.any()).optional(),
}).strict();

export type OutputEnvelope = z.infer<typeof OutputEnvelope>;
