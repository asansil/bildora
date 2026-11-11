/**
 * Rules on values in If and Switch conditions: which operators fit which type of value, and whether
 * a rule holds. Whether a file exists is asked of the caller, since only it may look at the disk.
 */
import type { ValueRuleOperator } from '../automation.js';
import { runtimeText } from './language.js';
import type { RuntimeValue, ValueType } from './language.js';

const NUMBER_OPERATORS: readonly ValueRuleOperator[] = [
  'equals',
  'not-equals',
  'greater-than',
  'less-than',
  'at-least',
  'at-most',
];
const TEXT_OPERATORS: readonly ValueRuleOperator[] = [
  'equals',
  'not-equals',
  'contains',
  'starts-with',
  'ends-with',
  'is-empty',
  'is-not-empty',
];

/** The operators a rule can use on a value of this type, in the order a list offers them. */
export function operatorsFor(type: ValueType): readonly ValueRuleOperator[] {
  switch (type) {
    case 'integer':
    case 'number':
      return NUMBER_OPERATORS;
    case 'text':
      return TEXT_OPERATORS;
    case 'path':
      return [...TEXT_OPERATORS, 'exists', 'not-exists'];
    case 'boolean':
      return ['is-true', 'is-false', 'equals', 'not-equals'];
    case 'list':
      return ['contains', 'is-empty', 'is-not-empty'];
  }
}

/**
 * The type a rule compares with, given what it reads and its operator. Undefined when the operator
 * compares with nothing.
 */
export function comparedType(read: ValueType, operator: ValueRuleOperator): ValueType | undefined {
  switch (operator) {
    case 'is-empty':
    case 'is-not-empty':
    case 'is-true':
    case 'is-false':
    case 'exists':
    case 'not-exists':
      return undefined;
    case 'contains':
    case 'starts-with':
    case 'ends-with':
      return 'text';
    default:
      return read === 'path' ? 'text' : read;
  }
}

/** Tells whether a value of type `given` can be compared where `wanted` is expected. */
export function comparable(given: ValueType, wanted: ValueType): boolean {
  if (wanted === 'integer' || wanted === 'number') return given === 'integer' || given === 'number';
  if (wanted === 'text' || wanted === 'path') return given !== 'list';
  return given === wanted;
}

/**
 * Whether a rule holds for worked-out values. `exists` and `not-exists` are answered by `exists`,
 * which the caller gives after looking at the disk.
 */
export function valueRuleHolds(
  operator: ValueRuleOperator,
  read: RuntimeValue,
  value: RuntimeValue | undefined,
  exists = false,
): boolean {
  const text = runtimeText(read);
  const other = value === undefined ? '' : runtimeText(value);
  const isEmpty = Array.isArray(read) ? read.length === 0 : text === '';
  switch (operator) {
    case 'equals':
    case 'not-equals': {
      const same =
        typeof read === 'number' || typeof value === 'number'
          ? Number(read) === Number(value)
          : text === other;
      return operator === 'equals' ? same : !same;
    }
    case 'greater-than':
      return Number(read) > Number(value);
    case 'less-than':
      return Number(read) < Number(value);
    case 'at-least':
      return Number(read) >= Number(value);
    case 'at-most':
      return Number(read) <= Number(value);
    case 'contains':
      return Array.isArray(read) ? read.includes(other) : text.includes(other);
    case 'starts-with':
      return text.startsWith(other);
    case 'ends-with':
      return text.endsWith(other);
    case 'is-empty':
      return isEmpty;
    case 'is-not-empty':
      return !isEmpty;
    case 'is-true':
      return read === true;
    case 'is-false':
      return read === false;
    case 'exists':
      return exists;
    case 'not-exists':
      return !exists;
  }
}
