function withoutQueryOrHash(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return undefined;
  }
}

/**
 * Tells whether an IPC message comes from the shell page itself. Only one page may talk to main, so
 * anything else that ever loads, such as a future tool panel, is refused here by default.
 */
export function isTrustedSender(frameUrl: string | undefined, rendererUrl: string): boolean {
  if (frameUrl === undefined) {
    return false;
  }
  const sender = withoutQueryOrHash(frameUrl);
  return sender !== undefined && sender === withoutQueryOrHash(rendererUrl);
}
