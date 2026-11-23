import { createContext, use, useId } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

/** Which sections of the settings panel are folded, kept by the Workspace for every automation. */
export interface PanelSections {
  readonly folded: ReadonlySet<string>;
  readonly onFold: (key: string, folded: boolean) => void;
}

export const PanelSectionsContext = createContext<PanelSections>({
  folded: new Set(),
  onFold: () => undefined,
});

/**
 * A titled part of the settings panel that folds shut. `id` names it across blocks of a kind, such
 * as `run.failure`, so folding it once folds it for every block of that kind.
 */
export function PanelSection({
  id,
  title,
  count,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly count?: number;
  readonly children: ReactNode;
}) {
  const { folded, onFold } = use(PanelSectionsContext);
  const bodyId = useId();
  const open = !folded.has(id);
  return (
    <section className="panel-section" data-open={open} data-section={id}>
      <h3 className="panel-section-title">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => {
            onFold(id, open);
          }}
        >
          <ChevronDown className="icon panel-section-chevron" aria-hidden="true" />
          <span>{title}</span>
          {count === undefined ? null : <span className="panel-section-count">{count}</span>}
        </button>
      </h3>
      <div className="panel-section-body" id={bodyId} hidden={!open}>
        {children}
      </div>
    </section>
  );
}
