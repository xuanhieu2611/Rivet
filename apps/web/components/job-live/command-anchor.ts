/** Stable fragment ids shared by agent timeline links and command rows. */
export function commandAnchorId(executionId: string): string {
  return `command-${executionId}`;
}
