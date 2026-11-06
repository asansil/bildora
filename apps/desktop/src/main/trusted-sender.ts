/**
 * One file can be written as a URL in several ways, and the two compared here come from different
 * encoders: Node writes `~` as `%7E`, as in the 8.3 paths of `RUNNER~1`, and Chromium leaves it. So
 * paths are compared decoded. Windows drive letters have no case, and a start from a shell in `c:\`
 * gives a lowercase one where Chromium reports the uppercase.
 */
function canonicalPath({ protocol, pathname }: URL): string {
  return protocol === 'file:'
    ? decodeURIComponent(pathname).replace(/^\/[a-z]:/, (drive) => drive.toUpperCase())
    : pathname;
}

function withoutQueryOrHash(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${canonicalPath(parsed)}`;
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
