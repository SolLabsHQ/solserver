export function postOutputLinter(args: {
  modeLabel: string;
  content: string;
}): { ok: true } | { ok: false; error: string } {
  // v0 placeholder: always OK
  return { ok: true };
}
