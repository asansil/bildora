import { useEffect, useMemo, useState } from 'react';
import type { AutomationBlock } from '@bildora/protocol';
import type { ProfileView } from '../../../shared/ipc-contract.js';

const api = window.bildora;

/**
 * The profile each block uses, by block id, so that a link to a block can show the value its
 * profile gives. Profiles of a tool are read once while the flow is open.
 */
export function useBlockProfiles(
  blocks: readonly AutomationBlock[],
  onError: (error: unknown) => void,
): ReadonlyMap<string, ProfileView> {
  const [byTool, setByTool] = useState<ReadonlyMap<string, readonly ProfileView[]>>(new Map());
  const wanted = useMemo(
    () =>
      [
        ...new Set(
          blocks.flatMap((block) =>
            block.type === 'run' && block.profile !== undefined ? [block.tool] : [],
          ),
        ),
      ].sort(),
    [blocks],
  );
  const key = wanted.join('\n');

  useEffect(() => {
    let current = true;
    const missing = key === '' ? [] : key.split('\n').filter((tool) => !byTool.has(tool));
    if (missing.length === 0) return undefined;
    void Promise.all(missing.map(async (tool) => [tool, await api.listProfiles(tool)] as const))
      .then((loaded) => {
        if (!current) return;
        setByTool((known) => new Map([...known, ...loaded]));
      })
      .catch(onError);
    return () => {
      current = false;
    };
  }, [key, byTool, onError]);

  return useMemo(
    () =>
      new Map(
        blocks.flatMap((block) => {
          if (block.type !== 'run' || block.profile === undefined) return [];
          const profile = byTool.get(block.tool)?.find(({ id }) => id === block.profile);
          return profile === undefined ? [] : [[block.id, profile] as const];
        }),
      ),
    [blocks, byTool],
  );
}
