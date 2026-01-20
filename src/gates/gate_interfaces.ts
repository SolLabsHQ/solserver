export const GATE_SENTINEL = "sentinel" as const;

export interface GateOutput {
  gateName: string;
  status: "pass" | "fail" | "warn";
  summary: string;
  is_urgent?: boolean;
  metadata?: Record<string, any>;
}
