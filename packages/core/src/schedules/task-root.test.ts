import { describe, expect, it } from 'vitest';
import { resolveDataDir } from '../storage/data-directory.js';
import { taskRootFor } from './windows-scheduler.js';

describe('taskRootFor', () => {
  it('keeps the usual folder for the usual data directory, and another for any other', () => {
    const usual = resolveDataDir({ env: { ...process.env, BILDORA_DATA_DIR: undefined } });
    expect(taskRootFor(usual)).toBe('\\Bildora\\');
    expect(taskRootFor(usual.toUpperCase())).toBe('\\Bildora\\');
    const other = taskRootFor('C:\\Temp\\bildora-e2e\\data');
    expect(other).toMatch(/^\\Bildora-[0-9a-f]{8}\\$/);
    expect(taskRootFor('c:\\temp\\BILDORA-E2E\\data')).toBe(other);
  });
});
