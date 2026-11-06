export interface ShellWebPreferences {
  readonly preload: string;
  readonly sandbox: true;
  readonly contextIsolation: true;
  readonly nodeIntegration: false;
  readonly webSecurity: true;
}

/** Security baseline for the shell window; stated explicitly so a change shows up in review. */
export function shellWebPreferences(preload: string): ShellWebPreferences {
  return {
    preload,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
  };
}
