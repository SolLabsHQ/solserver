export interface GateOutput {
  gateName: string;
  status: "pass" | "fail" | "warn";
  summary: string;
  metadata?: Record<string, any>;
}
