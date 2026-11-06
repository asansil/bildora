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

/** Height of the top bar, which the window's native caption buttons must match. */
export const TOP_BAR_HEIGHT = 36;

export interface TitleBarOverlay {
  readonly color: string;
  readonly symbolColor: string;
  readonly height: number;
}

/** Native caption buttons, drawn over the top bar. Transparent, so the theme's frame shows. */
export function titleBarOverlay(dark: boolean): TitleBarOverlay {
  return {
    color: '#00000000',
    symbolColor: dark ? '#e6e9eb' : '#2a2e31',
    height: TOP_BAR_HEIGHT,
  };
}
