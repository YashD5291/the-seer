/** The text of anything thrown: an Error's message, or the value as a string. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
