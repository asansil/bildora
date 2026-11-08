import { useEffect, useId, useState } from 'react';
import { t } from '../../shared/i18n/translate.js';
import type { MessageKey } from '../../shared/i18n/translate.js';
import type {
  AutomationDraft,
  AutomationProblemView,
  AutomationStep,
  AutomationView,
  ToolView,
} from '../../shared/ipc-contract.js';
import { StepEditor } from './StepEditor.js';
import { moveStep, newStep } from './automation-draft.js';
import type { StepKind } from './automation-draft.js';

const api = window.bildora;

/** How long typing has to pause before a draft is checked. */
const CHECK_DELAY_MS = 200;

const STEP_KINDS: readonly { readonly kind: StepKind; readonly label: MessageKey }[] = [
  { kind: 'run', label: 'automation.addRun' },
  { kind: 'wait-for-completion', label: 'automation.addCompletion' },
  { kind: 'wait-for-time', label: 'automation.addTime' },
  { kind: 'wait-for-manual-action', label: 'automation.addManual' },
];

interface AutomationEditorProps {
  /** Absent for a new automation. */
  readonly automation: AutomationView | undefined;
  readonly tools: readonly ToolView[];
  readonly onSave: (draft: AutomationDraft) => void;
  readonly onClose: () => void;
  readonly onError: (error: unknown) => void;
  /** Told whether the draft differs from what is saved, so closing its tab can ask first. */
  readonly onDirty?: (dirty: boolean) => void;
  /** Called on the first change, which pins a preview tab. */
  readonly onUsed?: () => void;
}

/** Builds or changes an automation. Saving never runs it, and a broken step can still be saved. */
export function AutomationEditor({
  automation,
  tools,
  onSave,
  onClose,
  onError,
  onDirty,
  onUsed,
}: AutomationEditorProps) {
  const nameId = useId();
  const descriptionId = useId();
  const [name, setName] = useState(automation?.name ?? '');
  const [description, setDescription] = useState(automation?.description ?? '');
  const [steps, setSteps] = useState<readonly AutomationStep[]>(automation?.steps ?? []);
  const [found, setFound] = useState<readonly AutomationProblemView[]>([]);

  const trimmed = name.trim();
  const trimmedDescription = description.trim();
  const canSave = trimmed !== '' && steps.length > 0;
  const problems = canSave ? found : [];
  const dirty =
    name !== (automation?.name ?? '') ||
    description !== (automation?.description ?? '') ||
    JSON.stringify(steps) !== JSON.stringify(automation?.steps ?? []);

  useEffect(() => {
    onDirty?.(dirty);
    if (dirty) {
      onUsed?.();
    }
  }, [dirty, onDirty, onUsed]);

  useEffect(
    () => () => {
      onDirty?.(false);
    },
    [onDirty],
  );

  function draft(): AutomationDraft {
    return {
      ...(automation === undefined ? {} : { id: automation.id }),
      name: trimmed,
      ...(trimmedDescription === '' ? {} : { description: trimmedDescription }),
      steps: [...steps],
    };
  }

  useEffect(() => {
    if (!canSave) {
      return undefined;
    }
    let current = true;
    const timer = setTimeout(() => {
      void api
        .checkAutomation({ name: trimmed, steps: [...steps] })
        .then((list) => {
          if (current) {
            setFound(list);
          }
        })
        .catch(onError);
    }, CHECK_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [canSave, trimmed, steps, onError]);

  function changeStep(index: number, step: AutomationStep): void {
    setSteps((current) => current.map((item, position) => (position === index ? step : item)));
  }

  function addStep(kind: StepKind): void {
    const step = newStep(kind, steps, tools);
    if (step !== undefined) {
      setSteps([...steps, step]);
    }
  }

  const general = problems.filter(({ stepId }) => stepId === '');

  return (
    <section className="history-detail" data-testid="automation-editor">
      <header className="tool-header">
        <h1>{automation === undefined ? t('automation.newTitle') : automation.name}</h1>
      </header>
      <div className="field">
        <label className="field-label" htmlFor={nameId}>
          {t('automation.name')}
        </label>
        <input
          id={nameId}
          autoFocus
          value={name}
          maxLength={200}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </div>
      <div className="field">
        <label className="field-label" htmlFor={descriptionId}>
          {t('automation.description')}
        </label>
        <input
          id={descriptionId}
          value={description}
          maxLength={1000}
          onChange={(event) => {
            setDescription(event.target.value);
          }}
        />
      </div>
      <h2>{t('automation.steps')}</h2>
      {steps.length === 0 ? <p className="muted">{t('automation.noSteps')}</p> : null}
      <ol className="step-cards">
        {steps.map((step, index) => (
          <StepEditor
            key={step.id}
            step={step}
            index={index}
            steps={steps}
            tools={tools}
            problems={problems.filter(({ stepId }) => stepId === step.id)}
            onChange={(next) => {
              changeStep(index, next);
            }}
            onMove={(delta) => {
              setSteps(moveStep(steps, index, delta));
            }}
            onRemove={() => {
              setSteps(steps.filter((_item, position) => position !== index));
            }}
            onError={onError}
          />
        ))}
      </ol>
      <div className="actions">
        {STEP_KINDS.map(({ kind, label }) => (
          <button
            key={kind}
            type="button"
            disabled={newStep(kind, steps, tools) === undefined}
            onClick={() => {
              addStep(kind);
            }}
          >
            {t(label)}
          </button>
        ))}
      </div>
      {general.map(({ message }) => (
        <p key={message} className="field-problem" data-testid="automation-problem">
          {message}
        </p>
      ))}
      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={!canSave}
          onClick={() => {
            onSave(draft());
          }}
        >
          {t('automation.save')}
        </button>
        <button type="button" onClick={onClose}>
          {t('form.cancel')}
        </button>
      </div>
    </section>
  );
}
