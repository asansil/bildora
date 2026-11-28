# Scheduling automations

**Purpose:** Explains how to run a Bildora automation on a schedule, from the app or by hand with Windows Task Scheduler, for anyone who has an automation working in the app and wants it to run unattended.

Bildora has no scheduler of its own and no background service. Windows Task Scheduler starts Bildora at the chosen time, Bildora runs the automation with no window open, and ends when the automation does. The app is not needed while it runs.

## Scheduling from the app

Open the automation and select its Start block.

1. Under **Starts**, choose **On a schedule**.
2. In **Repeats**, choose **Once**, **Every day**, **Every week** or **Every few hours**, then the date, days or hours and the time.
3. **Run as soon as it can if the computer was off or asleep** is on by default. A run missed that way starts once when the computer is back, however many were missed. Turn it off when the automation only makes sense at its time.
4. **Time limit** is two hours by default. When it runs out, Windows ends the run, and history shows it as cancelled.
5. Save the automation.
6. At the top of the panel, turn on **Active**. This creates the task in Task Scheduler.

The schedule is part of the automation file, but turning it on is not. It belongs to this computer, so an automation shared with you or imported never starts running on its own: whoever receives it turns it on where they want it to run.

Once it is on, the Start block shows the schedule in short, such as `Mon, Fri 07:00`, and the card at the top of the panel shows the next run and how the last one ended. The run also appears in history, marked as started by its schedule. Runs with the computer on battery are allowed.

Changing the schedule and saving updates the task. Turning **Active** off, or deleting the automation, removes it. Switching **Starts** back to **With Run** keeps the schedule in the file but removes the task until the block starts on a schedule again.

### When it cannot be turned on

- **An input with no value:** a scheduled run has nobody to type an input in. Every required input needs a default in **Run inputs**, or must be optional.
- **A time already gone:** a schedule that runs once needs a time still to come.

### Running when nobody is signed in

By default a task runs only while you are signed in to Windows, locked or not, and needs no password and no administrator rights. **Run when nobody is signed in** also runs it after you sign out. It asks for administrator rights, because Windows allows this mode only to an administrator, and it stores no password, so the automation cannot reach network folders. See [Running with the user logged off](#running-with-the-user-logged-off) for what was verified. To reach network folders with nobody signed in, create the task by hand with a stored password.

For the same reason, changing the schedule of such a task needs administrator rights again. Saving never asks for them on its own: the card at the top of the panel says the task is out of date, and **Update…** asks for them.

### Tasks changed outside Bildora

The app keeps its tasks in Task Scheduler under the `Bildora` folder, one folder per Workspace. Each time it starts, it compares them with the automations. A task whose automation is gone or turned off is removed, and one whose automation changed is brought up to date.

A task changed or removed in Task Scheduler is left as it is, and the Start block says so:

- **Removed outside Bildora:** **Create it again** creates the task from the block.
- **Changed outside Bildora,** including turned off there: the task may not run as the block says. **Restore from this block** writes the task again from the block, which undoes the change.

To schedule an automation in a way the app does not offer, leave **Active** off and [create the task by hand](#creating-the-task-by-hand) instead.

## The command

The zip holds `bildora.cmd` next to `Bildora.exe`.

```text
bildora run <automation> [--workspace <id or name>] [--input <name>=<value>]...
```

`<automation>` is the automation's id or its name, in any case. The automation's screen in the app shows the exact command. Put the name in quotes if it has spaces.

If several Workspaces hold the same automation, the command stops and lists them, and `--workspace` chooses one. Use `--workspace` in a scheduled task, so a later automation with the same name cannot stop it.

`--input` gives a value to one of the automation's inputs, and can be repeated, as in `--input file="D:\in\report.csv" --input size=100`. Inputs left out take their defaults. A yes-or-no input takes `true` or `false`. An input name the automation does not declare, a value of the wrong type, or a required input with no value and no default stops the command with code 2 before anything runs.

Each block that runs a tool or waits prints one line, such as `[2/3] report: completed (4.1 s)`, and one that was on a path the run did not take prints `skipped`. Tool output goes to run history, where the app shows it, marked as coming from the command line.

### Exit codes

| Code | Meaning                                                                      |
| ---- | ---------------------------------------------------------------------------- |
| 0    | Every block that ran succeeded                                               |
| 1    | A failed block stopped the automation                                        |
| 2    | The command was used incorrectly, or an input does not fit                   |
| 3    | The automation finished, but a block failed and its Error output handled it  |
| 4    | It stopped at a manual block, because nobody could answer                    |
| 5    | It could not start: not found, in several Workspaces, or with a broken block |
| 130  | It was cancelled                                                             |

Task Scheduler shows this number as the task's last run result, and so does **Last run** in the Start block for a task the app created.

## Creating the task by hand

A task created by hand runs the command above. Bildora does not show it in the Start block or change it.

1. Open Task Scheduler and choose **Create Task**, not Create Basic Task, because the settings below are not in the basic form.
2. On **General**, name the task, and keep it out of the `Bildora` folder, which the app manages. To run it whether or not you are signed in, choose **Run whether user is logged on or not**, and read [Running with the user logged off](#running-with-the-user-logged-off) to choose between storing your password or not.
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
- **Console scripts:** a tool that declares a console script always has it applied, because nobody is there to answer. If the text a script waits for never appears, the tool is ended after the wait's time limit, 30 seconds unless the manifest sets another, and its block fails.
- **Ending a task:** stopping the task from Task Scheduler ends the command at once. A tool in a Bildora console ends with it. A registered program in its own window can stay open, and the run shows as cancelled with a note that its result is unknown.

## Running with the user logged off

**Verified** on 2026-11-08 with the 0.1.0-alpha.1 package, on Windows 11 Home with a Microsoft account. With the user signed out, a scheduled automation ran a level 1 tool in a Bildora console, read a secret saved in a profile, and wrote its run to history, which the app showed afterwards. It worked in both modes below.

Verified again on 2026-11-28 with tasks the app created from the Start block, on the same package version. A run once started with the app closed and the user signed in, and another with **Run when nobody is signed in** on and the user signed out. Both wrote their run to history, marked as started by their schedule.

| Mode on **General**                                     | Password needed        | Reaches network shares |
| ------------------------------------------------------- | ---------------------- | ---------------------- |
| **Run whether user is logged on or not**                | Yes, stored by Windows | Yes                    |
| The same, with **Do not store password** also turned on | No                     | No                     |

- **Do not store password** suits tools that work only with this computer's files. Task Scheduler must be opened as administrator to save the task in this mode.
- **Storing the password** is needed when a tool reads or writes a network share. Windows asks for your account password, not your PIN, and asks again each time the password changes; until then, the task does not start.
- **Windows Hello only:** if **Settings > Accounts > Sign-in options** only allows Windows Hello for Microsoft accounts, Windows does not accept the password, and Task Scheduler reports that the user is unknown or the password is wrong. Use **Do not store password**, or turn that option off and sign in once with your password.
- **Registered programs** were not part of the test. A level 0 tool that opens a window has no desktop to show it on, so it may wait unseen until the task's time limit ends it.
