import { useEffect, useRef } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import type { ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { t } from '../../shared/i18n/translate.js';
import type { RunOutputView } from '../../shared/ipc-contract.js';

const api = window.bildora;
const SCROLLBACK_LINES = 5000;

export interface ConsoleSize {
  readonly columns: number;
  readonly rows: number;
}

/** Reads the console's colors from the stylesheet, so that tokens stay the one source of them. */
function themeFrom(element: HTMLElement): ITheme {
  const style = getComputedStyle(element);
  return {
    background: style.backgroundColor,
    foreground: style.color,
    cursor: style.color,
    selectionBackground: style.getPropertyValue('--console-selection').trim(),
  };
}

interface ConsolePaneProps {
  /** The run on show. Undefined before the tool has run in this session. */
  readonly runId: string | undefined;
  readonly running: boolean;
  /** Called as the size changes, so a run can start at the size it will be shown. */
  readonly onSize: (size: ConsoleSize) => void;
}

/** A live view of a run. Output is replayed from main, so it survives leaving the tool and back. */
export function ConsolePane({ runId, running, onSize }: ConsolePaneProps) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | undefined>(undefined);
  const live = useRef<string | undefined>(undefined);

  useEffect(() => {
    live.current = running ? runId : undefined;
  }, [runId, running]);

  useEffect(() => {
    const element = host.current;
    if (element === null) {
      return undefined;
    }
    const style = getComputedStyle(element);
    const console_ = new Terminal({
      fontFamily: style.fontFamily,
      fontSize: 12,
      scrollback: SCROLLBACK_LINES,
      // ANSI colors are the tool's choice, and this keeps them readable on either theme.
      minimumContrastRatio: 4.5,
      theme: themeFrom(element),
    });
    const fit = new FitAddon();
    console_.loadAddon(fit);
    console_.open(element);
    terminal.current = console_;

    // Shortcuts of the shell must still work with the console in focus.
    console_.attachCustomKeyEventHandler(
      (event) => !(event.ctrlKey && event.key.toLowerCase() === 'k'),
    );
    const typing = console_.onData((data) => {
      if (live.current !== undefined) {
        void api.sendRunInput(live.current, data);
      }
    });

    let known: ConsoleSize | undefined;
    function refit(): void {
      if (element?.offsetWidth === 0) {
        return;
      }
      fit.fit();
      const { cols: columns, rows } = console_;
      if (columns === known?.columns && rows === known.rows) {
        return;
      }
      known = { columns, rows };
      onSize(known);
      if (live.current !== undefined) {
        void api.resizeRun(live.current, columns, rows);
      }
    }
    const observer = new ResizeObserver(refit);
    observer.observe(element);
    refit();

    return () => {
      observer.disconnect();
      typing.dispose();
      terminal.current = undefined;
      console_.dispose();
    };
  }, [onSize]);

  // The theme can change from Settings or from Windows, and both end up here.
  useEffect(() => {
    const scheme = window.matchMedia('(prefers-color-scheme: dark)');
    const recolor = (): void => {
      if (host.current !== null && terminal.current !== undefined) {
        terminal.current.options.theme = themeFrom(host.current);
      }
    };
    scheme.addEventListener('change', recolor);
    return () => {
      scheme.removeEventListener('change', recolor);
    };
  }, []);

  useEffect(() => {
    const console_ = terminal.current;
    console_?.reset();
    if (console_ === undefined || runId === undefined) {
      return undefined;
    }

    let shown = -1;
    let early: RunOutputView[] | undefined = [];
    function show(output: RunOutputView): void {
      if (output.sequence > shown) {
        shown = output.sequence;
        console_?.write(output.data);
      }
    }
    const stopListening = api.onRunOutput((output) => {
      if (output.runId === runId) {
        if (early === undefined) {
          show(output);
        } else {
          early.push(output);
        }
      }
    });
    let current = true;
    void api.readRunOutput(runId).then((replay) => {
      if (current) {
        if (replay !== undefined) {
          show(replay);
        }
        early?.forEach(show);
        early = undefined;
      }
    });
    return () => {
      current = false;
      stopListening();
    };
  }, [runId]);

  return (
    <div
      ref={host}
      className="console"
      role="group"
      aria-label={t('runner.console')}
      data-testid="console"
    />
  );
}
