/**
 * Windows drive letters have no case, yet the two URLs compared here can spell one differently: a
 * start from a shell in `c:\` gives a lowercase module path, and Chromium reports the uppercase.
 */
function withDriveLetterInCapitals({ protocol, pathname }: URL): string {
  return protocol === 'file:'
    ? pathname.replace(/^\/[a-z]:/, (drive) => drive.toUpperCase())
    : pathname;
}

function withoutQueryOrHash(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${withDriveLetterInCapitals(parsed)}`;
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
