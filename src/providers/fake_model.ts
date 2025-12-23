export async function fakeModelReply(input: {
  userText: string;
  modeLabel: string;
}): Promise<string> {
  return `[${input.modeLabel}] Stub response: I received ${input.userText.length} chars.`;
}
