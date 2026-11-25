import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { resolveDataDir } from '../storage/data-directory.js';
import { SchedulerError } from './system-scheduler.js';
import type {
  PutTaskOptions,
  SystemScheduler,
  SystemTask,
  TaskLocation,
} from './system-scheduler.js';

/** Task Scheduler's own codes for a task that has never run, and for one running now. */
const NEVER_RAN = 0x41303;
const RUNNING = 0x41301;
/** Task Scheduler writes this date as the last run of a task that never ran. */
const NEVER_RAN_YEAR = 1999;
const ACCESS_DENIED = /0x80070005|access is denied|acceso denegado/i;
/** What PowerShell's Start-Process says when someone answers No to the administrator prompt. */
const ELEVATION_REFUSED = /canceled by the user|cancelad[ao] por el usuario/i;
const POWERSHELL_TIMEOUT_MS = 60_000;
/** Stops at the first error, and keeps progress records, which PowerShell writes to stderr, out. */
const PREAMBLE = "$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'";

/**
 * The Task Scheduler folder for one data directory. The usual one has `\Bildora\`; any other, such
 * as a test's, gets a folder of its own, so that tidying its tasks never touches the real ones.
 */
export function taskRootFor(dataDir: string): string {
  const usual = resolveDataDir({ env: { ...process.env, BILDORA_DATA_DIR: undefined } });
  if (usual.toLowerCase() === dataDir.toLowerCase()) return '\\Bildora\\';
  const hash = createHash('sha256').update(dataDir.toLowerCase()).digest('hex').slice(0, 8);
  return `\\Bildora-${hash}\\`;
}

export interface WindowsSchedulerOptions {
  /** The top folder of Bildora's tasks, such as `\Bildora\`. Tests use one of their own. */
  readonly root?: string;
  readonly powershell?: string;
}

/** Quotes text as a PowerShell literal string. */
function literal(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

function encoded(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

interface ListedTask {
  readonly path: string;
  readonly name: string;
  readonly state: string;
  readonly xml: string;
  readonly next: string | null;
  readonly last: string | null;
  readonly result: number | null;
}

function isListedTask(value: unknown): value is ListedTask {
  return (
    typeof value === 'object' &&
    value !== null &&
    'path' in value &&
    typeof value.path === 'string' &&
    'name' in value &&
    typeof value.name === 'string' &&
    'xml' in value &&
    typeof value.xml === 'string'
  );
}

/** Task Scheduler on Windows, through the ScheduledTasks module of Windows PowerShell. */
export class WindowsScheduler implements SystemScheduler {
  readonly user: string;
  private readonly root: string;
  private readonly powershell: string;

  constructor(options: WindowsSchedulerOptions = {}) {
    const root = options.root ?? '\\Bildora\\';
    this.root = root.endsWith('\\') ? root : `${root}\\`;
    this.powershell = options.powershell ?? 'powershell.exe';
    const domain = process.env['USERDOMAIN'];
    const name = userInfo().username;
    this.user = domain === undefined || domain === '' ? name : `${domain}\\${name}`;
  }

  private folderOf({ workspaceId }: TaskLocation): string {
    return `${this.root}${workspaceId}\\`;
  }

  private run(script: string): Promise<string> {
    // An error caught inside the script would otherwise still end PowerShell with code 1.
    const full = `${PREAMBLE}\n[Console]::OutputEncoding = [Text.Encoding]::UTF8\n${script}\nexit 0`;
    return new Promise((resolve, reject) => {
      execFile(
        this.powershell,
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-EncodedCommand',
          encoded(full),
        ],
        { windowsHide: true, timeout: POWERSHELL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve(stdout);
            return;
          }
          const message = stderr.trim() || error.message;
          reject(new SchedulerError(message, ACCESS_DENIED.test(message) ? 'denied' : 'failed'));
        },
      );
    });
  }

  /**
   * Runs a script with administrator rights, which Windows asks the person for. The script runs in
   * a second PowerShell, so its errors come back through a file.
   */
  private async runElevated(script: string): Promise<void> {
    const folder = await mkdtemp(join(tmpdir(), 'bildora-task-'));
    const errorFile = join(folder, 'error.txt');
    const inner = `${PREAMBLE}\ntry {\n${script}\n} catch {\n  Set-Content -LiteralPath ${literal(errorFile)} -Value $_.Exception.Message -Encoding UTF8\n  exit 1\n}`;
    try {
      await this.run(
        `$p = Start-Process -FilePath ${literal(this.powershell)} -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',${literal(encoded(inner))}\nexit $p.ExitCode`,
      ).catch((error: unknown) => {
        if (error instanceof SchedulerError && ELEVATION_REFUSED.test(error.message)) {
          throw new SchedulerError('Administrator rights were not given', 'denied');
        }
        throw error;
      });
    } catch (error) {
      const detail = await readFile(errorFile, 'utf8').catch(() => '');
      if (detail.trim() !== '') throw new SchedulerError(detail.trim(), 'failed');
      throw error;
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }

  async put(location: TaskLocation, xml: string, options: PutTaskOptions): Promise<void> {
    const folder = await mkdtemp(join(tmpdir(), 'bildora-task-'));
    const file = join(folder, 'task.xml');
    try {
      await writeFile(file, xml, 'utf8');
      const script = `$xml = Get-Content -Raw -Encoding UTF8 -LiteralPath ${literal(file)}\nRegister-ScheduledTask -Xml $xml -TaskPath ${literal(this.folderOf(location))} -TaskName ${literal(location.automationId)} -Force | Out-Null`;
      if (options.elevated) {
        await this.runElevated(script);
        return;
      }
      try {
        await this.run(script);
      } catch (error) {
        // A task first saved for runs with nobody signed in can only be replaced as administrator.
        if (!(error instanceof SchedulerError) || error.reason !== 'denied') throw error;
        await this.runElevated(script);
      }
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }

  async remove(location: TaskLocation): Promise<void> {
    // Under Stop, these cmdlets throw for a missing task whatever -ErrorAction says.
    const script = `$task = $null\ntry { $task = Get-ScheduledTask -TaskPath ${literal(this.folderOf(location))} -TaskName ${literal(location.automationId)} } catch {}\nif ($null -ne $task) { $task | Unregister-ScheduledTask -Confirm:$false }`;
    try {
      await this.run(script);
    } catch (error) {
      if (!(error instanceof SchedulerError) || error.reason !== 'denied') throw error;
      await this.runElevated(script);
    }
  }

  async list(): Promise<readonly SystemTask[]> {
    const output = await this.run(
      [
        `$tasks = @(); try { $tasks = @(Get-ScheduledTask -TaskPath ${literal(`${this.root}*`)}) } catch {}`,
        '$rows = @(foreach ($task in $tasks) {',
        '  $info = $task | Get-ScheduledTaskInfo',
        '  [pscustomobject]@{',
        '    path = $task.TaskPath; name = $task.TaskName; state = [string]$task.State',
        '    xml = [string](Export-ScheduledTask -TaskPath $task.TaskPath -TaskName $task.TaskName)',
        "    next = if ($info.NextRunTime) { $info.NextRunTime.ToString('o') } else { $null }",
        "    last = if ($info.LastRunTime) { $info.LastRunTime.ToString('o') } else { $null }",
        '    result = [long]$info.LastTaskResult',
        '  }',
        '})',
        'ConvertTo-Json -InputObject $rows -Depth 3 -Compress',
      ].join('\n'),
    );
    const parsed: unknown = JSON.parse(output.trim() === '' ? '[]' : output);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const tasks: SystemTask[] = [];
    for (const row of rows) {
      if (!isListedTask(row) || !row.path.toLowerCase().startsWith(this.root.toLowerCase()))
        continue;
      const workspaceId = row.path.slice(this.root.length).replace(/\\$/, '');
      if (workspaceId === '' || workspaceId.includes('\\')) continue;
      const last = row.last === null ? undefined : new Date(row.last);
      const ran = last !== undefined && last.getFullYear() > NEVER_RAN_YEAR;
      tasks.push({
        workspaceId,
        automationId: row.name,
        xml: row.xml,
        running: row.state === 'Running' || row.result === RUNNING,
        ...(row.next === null ? {} : { nextRun: new Date(row.next) }),
        ...(ran ? { lastRun: last } : {}),
        ...(ran && row.result !== null && row.result !== NEVER_RAN && row.result !== RUNNING
          ? { lastResult: row.result }
          : {}),
      });
    }
    return tasks;
  }
}
