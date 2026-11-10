/**
 * What history keeps of the values a block received and produced, for the data view and for testing
 * a block later. Secrets are left out, and long values are shortened so a record stays small.
 */
import { isExpressionValue } from '@bildora/protocol';
import type { RunBlock } from '@bildora/protocol';
import type { StepOutputRecord, StepValueRecord } from '../history/run-history.js';
import type { RecordedParameter } from '../runner/resolve-values.js';
import type { OutputValue } from './automation-values.js';

/** Characters of JSON one block's values and outputs may take in history, roughly. */
export const STEP_DATA_LIMIT = 64 * 1024;
/** Characters kept of one text once a record is over its limit. */
const SHORT_TEXT = 1024;
/** Items kept of one list once a record is over its limit. */
const SHORT_LIST = 50;

/** The values a tool received, with the link or expression each worked-out one came from. */
export function stepValues(
  block: RunBlock,
  parameters: readonly RecordedParameter[],
): StepValueRecord[] {
  return parameters.map(({ name, label, value, secret }) => {
    const own = block.values?.[name];
    return {
      name,
      label,
      ...(secret === true ? { secret } : value === undefined ? {} : { value }),
      ...(isExpressionValue(own) ? { from: own.expression } : {}),
    };
  });
}

/** What a block left, each JSON field on its own, secret fields recorded without their value. */
export function stepOutputs(
  outputs: ReadonlyMap<string, OutputValue>,
  secretFields: ReadonlySet<string>,
): StepOutputRecord[] {
  return [...outputs].flatMap(([name, output]) => [
    { name, value: output.value },
    ...[...(output.fields ?? [])].map(([field, value]): StepOutputRecord => {
      const key = `${name}.${field}`;
      return secretFields.has(key) ? { name: key, secret: true } : { name: key, value };
    }),
  ]);
}

/** A record with its value left out. */
function withoutValue<Record extends { readonly value?: unknown }>(record: Record): Record {
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'value')) as Record;
}

function shortened<Value>(value: Value): Value {
  if (typeof value === 'string' && value.length > SHORT_TEXT) {
    return `${value.slice(0, SHORT_TEXT)}…` as Value;
  }
  if (Array.isArray(value) && value.length > SHORT_LIST) {
    return value.slice(0, SHORT_LIST) as Value;
  }
  return value;
}

/** Keeps a block's values and outputs within `STEP_DATA_LIMIT`, saying when it shortened any. */
export function limitStepData(
  values: readonly StepValueRecord[],
  outputs: readonly StepOutputRecord[],
): {
  readonly values: readonly StepValueRecord[];
  readonly outputs: readonly StepOutputRecord[];
  readonly truncated?: true;
} {
  if (JSON.stringify([values, outputs]).length <= STEP_DATA_LIMIT) return { values, outputs };
  const shortValues = values.map((record) =>
    record.value === undefined ? record : { ...record, value: shortened(record.value) },
  );
  const shortOutputs = outputs.map((record) =>
    record.value === undefined ? record : { ...record, value: shortened(record.value) },
  );
  if (JSON.stringify([shortValues, shortOutputs]).length <= STEP_DATA_LIMIT) {
    return { values: shortValues, outputs: shortOutputs, truncated: true };
  }
  // Still too much: keep the names, which say what there was, and drop the values.
  return {
    values: shortValues.map(withoutValue),
    outputs: shortOutputs.map(withoutValue),
    truncated: true,
  };
}
