import { en } from './en.js';
import type { Messages } from './en.js';

export type MessageKey = keyof Messages;
type Parameters = Readonly<Record<string, string | number>>;

const plurals = new Intl.PluralRules('en');

function select(message: Messages[MessageKey], parameters: Parameters): string {
  if (typeof message === 'string') {
    return message;
  }
  const count = Number(parameters['count'] ?? 0);
  return plurals.select(count) === 'one' ? message.one : message.other;
}

/** Finds the text for a key. A plural message picks its form from the `count` parameter. */
export function t(key: MessageKey, parameters: Parameters = {}): string {
  return select(en[key], parameters).replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    const value = parameters[name];
    return value === undefined ? placeholder : String(value);
  });
}
