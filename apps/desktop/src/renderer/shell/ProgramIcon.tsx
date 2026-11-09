import { useEffect, useState } from 'react';
import { AppWindow, SquareTerminal } from 'lucide-react';
import type { ToolView } from '../../shared/ipc-contract.js';

const api = window.bildora;

const FALLBACKS = { 0: AppWindow, 1: SquareTerminal } as const;

/**
 * Asked once per tool and program for the life of the page. Main caches by path too, so this only
 * saves the trips. A changed program gives a new entry, and so its new icon.
 */
const icons = new Map<string, Promise<string | undefined>>();

function iconOf(tool: ToolView): Promise<string | undefined> {
  const entry = `${tool.key}\n${tool.program}`;
  let icon = icons.get(entry);
  if (icon === undefined) {
    icon = api.toolIcon(tool.id).catch(() => undefined);
    icons.set(entry, icon);
  }
  return icon;
}

interface ProgramIconProps {
  readonly tool: ToolView;
  readonly className?: string;
}

/** The icon Windows shows for the tool's program, or one chosen by integration level. */
export function ProgramIcon({ tool, className = 'icon' }: ProgramIconProps) {
  const [icon, setIcon] = useState<string | undefined>(undefined);
  const [failed, setFailed] = useState<string | undefined>(undefined);

  useEffect(() => {
    let current = true;
    void iconOf(tool).then((found) => {
      if (current) {
        setIcon(found);
      }
    });
    return () => {
      current = false;
    };
  }, [tool]);

  if (icon !== undefined && icon !== failed) {
    return (
      <img
        className={`${className} program-icon`}
        src={icon}
        alt=""
        draggable={false}
        onError={() => {
          setFailed(icon);
        }}
      />
    );
  }
  const Fallback = FALLBACKS[tool.level];
  return <Fallback className={className} aria-hidden="true" />;
}
