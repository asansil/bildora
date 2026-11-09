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

Each block that runs a tool or waits prints one line, such as `[2/3] report: completed (4.1 s)`, and one that was on a path the run did not take prints `skipped`. Tool output goes to run history, where the app shows it, marked as coming from the command line.

### Exit codes

| Code | Meaning                                                                      |
| ---- | ---------------------------------------------------------------------------- |
| 0    | Every block that ran succeeded                                               |
| 1    | A failed block stopped the automation                                        |
| 2    | The command was used incorrectly                                             |
| 3    | The automation finished, but a block failed and its Error output handled it  |
| 4    | It stopped at a manual block, because nobody could answer                    |
| 5    | It could not start: not found, in several Workspaces, or with a broken block |
| 130  | It was cancelled                                                             |

Task Scheduler shows this number as the task's last run result.

## Creating the task

1. Open Task Scheduler and choose **Create Task**, not Create Basic Task, because the settings below are not in the basic form.
2. On **General**, name the task. To run it whether or not you are signed in, choose **Run whether user is logged on or not**, and read [Running with the user logged off](#running-with-the-user-logged-off) to choose between storing your password or not.
3. On **Triggers**, add the schedule.
4. On **Actions**, add **Start a program**:
   - **Program/script:** the full path to `bildora.cmd`
   - **Add arguments:** `run nightly-report --workspace Work`
5. On **Conditions**, first turn off **Stop if the computer switches to battery power**, then **Start the task only if the computer is on AC power**. If you keep the second one on, a laptop on battery silently skips the task. The first one goes grey once the second is off, but stays set, so turn it off while you still can.
6. On **Settings**, turn on **Stop the task if it runs longer than** and choose a limit. An automation has no time limit of its own, so this is what ends a tool that hangs.

Tools that need an interpreter, such as `node` or `python`, must find it on the `PATH` of the account that runs the task.

## What to keep in mind

- **Manual blocks:** with nobody at a terminal, a wait-for-manual-action block fails at once. The command never waits forever. With nothing on its Error output, the automation stops and the exit code is 4. With its Error output connected, the automation follows that path and the exit code is 3.
- **Older files:** an automation written as a list of steps runs as it always did. A step set to continue becomes an Error output to the next step, and a background step with its wait becomes parallel branches. A `continue` on the very last step has no next step to lead to, so a failure there now stops the automation with exit code 1, where it used to finish with exit code 3.
- **The app can stay open.** The command and the app can run at the same time, even the same automation. Each run has its own folder, but a tool that always writes to one fixed path is not protected from a second run.
- **Registered programs:** a level 0 tool opens in its own window, as it does in the app. A program that waits for someone to close it holds the automation until then, so give the task a time limit.
- **Level 2 tools** cannot run in an automation yet.
- **Ending a task:** stopping the task from Task Scheduler ends the command at once. A tool in a Bildora console ends with it. A registered program in its own window can stay open, and the run shows as cancelled with a note that its result is unknown.

## Running with the user logged off

**Verified** on 2026-11-08 with the 0.1.0-alpha.1 package, on Windows 11 Home with a Microsoft account. With the user signed out, a scheduled automation ran a level 1 tool in a Bildora console, read a secret saved in a profile, and wrote its run to history, which the app showed afterwards. It worked in both modes below.

| Mode on **General**                                     | Password needed        | Reaches network shares |
| ------------------------------------------------------- | ---------------------- | ---------------------- |
| **Run whether user is logged on or not**                | Yes, stored by Windows | Yes                    |
| The same, with **Do not store password** also turned on | No                     | No                     |

- **Do not store password** suits tools that work only with this computer's files. Task Scheduler must be opened as administrator to save the task in this mode.
- **Storing the password** is needed when a tool reads or writes a network share. Windows asks for your account password, not your PIN, and asks again each time the password changes; until then, the task does not start.
- **Windows Hello only:** if **Settings > Accounts > Sign-in options** only allows Windows Hello for Microsoft accounts, Windows does not accept the password, and Task Scheduler reports that the user is unknown or the password is wrong. Use **Do not store password**, or turn that option off and sign in once with your password.
- **Registered programs** were not part of the test. A level 0 tool that opens a window has no desktop to show it on, so it may wait unseen until the task's time limit ends it.
