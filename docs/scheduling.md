# Scheduling automations

**Purpose:** Explains how to run a Bildora automation on a schedule with Windows Task Scheduler, for anyone who has an automation working in the app and wants it to run unattended.

Bildora has no scheduler of its own and no background service. Task Scheduler starts the `bildora` command, which runs the automation with no window open and ends when the automation does.

## The command

The zip holds `bildora.cmd` next to `Bildora.exe`.

```text
bildora run <automation> [--workspace <id or name>]
```

`<automation>` is the automation's id or its name, in any case. The automation's screen in the app shows the exact command. Put the name in quotes if it has spaces.

If several Workspaces hold the same automation, the command stops and lists them, and `--workspace` chooses one. Use `--workspace` in a scheduled task, so a later automation with the same name cannot stop it.

Each step prints one line. Tool output goes to run history, where the app shows it, marked as coming from the command line.

### Exit codes

| Code | Meaning                                                                     |
| ---- | --------------------------------------------------------------------------- |
| 0    | Every step succeeded                                                        |
| 1    | A failed step stopped the automation                                        |
| 2    | The command was used incorrectly                                            |
| 3    | The automation finished, but a step set to continue failed                  |
| 4    | It stopped at a manual step, because nobody could answer                    |
| 5    | It could not start: not found, in several Workspaces, or with a broken step |
| 130  | It was cancelled                                                            |

Task Scheduler shows this number as the task's last run result.

## Creating the task

1. Open Task Scheduler and choose **Create Task**, not Create Basic Task, because the settings below are not in the basic form.
2. On **General**, name the task. Choose **Run only when user is logged on**, unless you checked the [logged-off notes](#running-with-the-user-logged-off).
3. On **Triggers**, add the schedule.
4. On **Actions**, add **Start a program**:
   - **Program/script:** the full path to `bildora.cmd`
   - **Add arguments:** `run nightly-report --workspace Work`
5. On **Conditions**, turn off **Start the task only if the computer is on AC power**. If you keep it on, a laptop on battery silently skips the task.
6. On **Settings**, turn on **Stop the task if it runs longer than** and choose a limit. An automation has no time limit of its own, so this is what ends a tool that hangs.

Tools that need an interpreter, such as `node` or `python`, must find it on the `PATH` of the account that runs the task.

## What to keep in mind

- **Manual steps:** with nobody at a terminal, a wait-for-manual-action step fails at once, under its failure policy. The command never waits forever. With `stop`, the exit code is 4. With `continue`, the automation goes on and the exit code is 3.
- **The app can stay open.** The command and the app can run at the same time, even the same automation. Each run has its own folder, but a tool that always writes to one fixed path is not protected from a second run.
- **Registered programs:** a level 0 tool opens in its own window, as it does in the app. A program that waits for someone to close it holds the automation until then, so give the task a time limit.
- **Level 2 tools** cannot run in an automation yet.
- **Ending a task:** stopping the task from Task Scheduler ends the command at once. A tool in a Bildora console ends with it. A registered program in its own window can stay open, and the run shows as cancelled with a note that its result is unknown.

## Running with the user logged off

<!-- LOGGED-OFF-RESULT: replace this section's status once the test has been run. -->

**Not verified yet.** Running with the user logged off has not been tested on a real machine, so treat it as unsupported and choose **Run only when user is logged on**.

Saved secrets are the part most likely to be affected: they live in the Windows credential store, which may not be available to a task with no stored password.
