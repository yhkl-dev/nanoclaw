export function isMissingClaudeSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /No conversation found with session ID:/i.test(message);
}
