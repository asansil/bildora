/** A side of the work area whose panel the top bar can fold. */
export type PanelSide = 'left' | 'bottom' | 'right';

/** A panel the top bar can fold or open: whether it is open, what it is called, and its shortcut. */
export interface LayoutPanel {
  readonly side: PanelSide;
  readonly open: boolean;
  readonly label: string;
  readonly shortcut: string;
}

export interface LayoutTogglesProps {
  readonly panels: readonly LayoutPanel[];
  readonly onToggle: (side: PanelSide) => void;
}

/** The part of the window frame each button stands for, filled while that panel is open. */
const SHAPES: Readonly<Record<PanelSide, { readonly fill: string; readonly line: string }>> = {
  left: { fill: 'M3 5a2 2 0 0 1 2-2h4v18H5a2 2 0 0 1-2-2z', line: 'M9 3v18' },
  bottom: { fill: 'M3 15h18v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', line: 'M3 15h18' },
  right: { fill: 'M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4z', line: 'M15 3v18' },
};

function PanelIcon({ side, open }: { readonly side: PanelSide; readonly open: boolean }) {
  const shape = SHAPES[side];
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {open ? <path d={shape.fill} fill="currentColor" stroke="none" /> : null}
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d={shape.line} />
    </svg>
  );
}

/**
 * Buttons beside the window's caption buttons that fold the panels around the work area. A panel
 * the active tab does not have gets no button.
 */
export function LayoutToggles({ panels, onToggle }: LayoutTogglesProps) {
  return (
    <div className="layout-toggles" data-testid="layout-toggles">
      {panels.map((panel) => (
        <button
          key={panel.side}
          type="button"
          className="icon-button"
          aria-label={panel.label}
          aria-pressed={panel.open}
          title={`${panel.label} (${panel.shortcut})`}
          data-testid={`toggle-${panel.side}`}
          onClick={() => {
            onToggle(panel.side);
          }}
        >
          <PanelIcon side={panel.side} open={panel.open} />
        </button>
      ))}
    </div>
  );
}
