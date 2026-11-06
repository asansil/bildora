import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';

interface DialogProps {
  /** Shown as a heading. Without it, `label` names the dialog for assistive technology. */
  readonly title?: string;
  readonly label?: string;
  readonly className?: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}

/**
 * A modal on the native `<dialog>`, which traps focus and handles Esc by itself. Removing an open
 * one does not give focus back, so this does.
 */
export function Dialog({ title, label, className, onClose, children }: DialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement;
    if (element !== null && !element.open) {
      element.showModal();
    }
    return () => {
      // Deferred: under StrictMode effects also clean up while the dialog stays mounted.
      queueMicrotask(() => {
        if (element?.isConnected !== true && previous instanceof HTMLElement) {
          previous.focus();
        }
      });
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      className={`dialog ${className ?? ''}`}
      aria-label={title === undefined ? label : undefined}
      aria-labelledby={title === undefined ? undefined : titleId}
      onClose={onClose}
      onClick={(event) => {
        // A click on the backdrop lands on the dialog element itself.
        if (event.target === dialog.current) {
          onClose();
        }
      }}
    >
      <div className="dialog-content">
        {title === undefined ? null : (
          <h2 id={titleId} className="dialog-title">
            {title}
          </h2>
        )}
        {children}
      </div>
    </dialog>
  );
}
