import { describe, expect, it } from 'vitest';
import { portText } from './block-text.js';

describe('portText', () => {
  it('names the input and says the flow comes in', () => {
    expect(portText('run', { input: true })).toEqual({
      name: 'Input',
      purpose: 'The flow comes in here',
    });
  });

  it('says what each output leads to', () => {
    const purpose = (kind: Parameters<typeof portText>[0], output: string) =>
      portText(kind, { input: false, output }).purpose;
    expect(purpose('run', 'next')).toBe('Continues here when this step ends');
    expect(purpose('run', 'error')).toBe('Continues here if this step fails');
    expect(purpose('if', 'true')).toBe('Continues here when the condition is true');
    expect(purpose('if', 'false')).toBe('Continues here when the condition is false');
    expect(purpose('switch', 'big')).toBe('Continues here when the value matches this case');
    expect(purpose('switch', 'default')).toBe('Continues here when no case matches');
  });

  it('reads a Switch case named like another output as a case', () => {
    expect(portText('switch', { input: false, output: 'error' }).purpose).toBe(
      'Continues here when the value matches this case',
    );
    expect(portText('switch', { input: false, output: 'true' }).purpose).toBe(
      'Continues here when the value matches this case',
    );
  });

  it('names an output as the canvas labels it', () => {
    expect(portText('run', { input: false, output: 'error' }).name).toBe('Error');
    expect(portText('switch', { input: false, output: 'big' }).name).toBe('big');
  });
});
