import { useEffect, useState } from 'react';
import { CornerLeftUp } from 'lucide-react';
import { t } from '../../shared/i18n/translate.js';
import type { RunCallerView } from '../../shared/ipc-contract.js';

const api = window.bildora;

/**
 * Which run called the one on view, with a way back to it. The caller is looked up in history,
 * where it is recorded as soon as it starts.
 */
export function CalledBy({
  caller,
  onShowRun,
}: {
  readonly caller: RunCallerView;
  readonly onShowRun: (automationId: string, runId: string) => void;
}) {
  const [found, setFound] = useState<
    { readonly runId: string; readonly id: string; readonly name: string } | undefined
  >(undefined);
  useEffect(() => {
    let current = true;
    void api
      .getHistoryAutomationRun(caller.runId)
      .then((record) => {
        if (current && record !== undefined) {
          setFound({
            runId: caller.runId,
            id: record.run.automationId,
            name: record.run.automationName,
          });
        }
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [caller.runId]);
  const known = found?.runId === caller.runId ? found : undefined;
  return (
    <button
      type="button"
      className="called-by"
      data-testid="called-by"
      disabled={known === undefined}
      onClick={() => {
        if (known !== undefined) onShowRun(known.id, caller.runId);
      }}
    >
      <CornerLeftUp className="icon" aria-hidden="true" />
      {t('automation.calledBy', {
        name: known?.name ?? '…',
        block: caller.blockId,
      })}
    </button>
  );
}
