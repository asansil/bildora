# Bildora 0.1.0-alpha.1

**Purpose:** Tells people trying the first alpha what it does, what it does not do yet, and how to report problems.

This is the first public build of Bildora, a desktop app that gathers the programs and scripts scattered around your machine, runs them from one place, and chains them into automations. It is an early alpha for Windows: expect rough edges, and do not rely on it for anything you cannot redo.

## What you can do

- **Bring in any program.** Add a `.exe`, `.py`, `.bat` or similar by picking it, dropping it on the window or scanning a folder. Nothing runs during detection.
- **Run declarative tools.** A `tool.yaml` beside an unchanged script gives it a generated form, a live console, saved profiles and run history.
- **Keep secrets out of files.** Secret values go to the Windows credential store, and stay out of run history.
- **Separate work with Workspaces.** Each has its own tools, automations, history, theme and layout.
- **Build automations.** Chain tools with waits and a pause for a person, set what happens when a step fails, and pass files from one step to the next.
- **Run automations with no window open.** `bildora run <automation>` returns a meaningful exit code, so Task Scheduler can run it. See `docs/scheduling.md`.

## Install

1. Download the zip and unzip it into a folder of your own.
2. Run `Bildora.exe`.

Your data lives in `%APPDATA%\Bildora`. To update, unzip the new version over the old one, or into a new folder. There is no auto-update yet.

## Known limits

- **The build is not signed.** Windows SmartScreen warns about it. Bildora does not sandbox tools: a tool you add runs with your permissions, so only add what you trust.
- **PowerShell scripts** need an execution policy that allows them, which Windows Home does not by default.
- **Tools need their interpreter.** Bildora warns if one is missing, and does not install it.
- **A scheduled run with the user logged off has not been verified.** Choose "Run only when user is logged on" in Task Scheduler.
- **Automations have no time limit of their own.** Set one on the scheduled task.
- **Not in this alpha:** integrated tools with their own panel, the Marketplace, importing and exporting Workspaces, the installer, Linux, and any interface language but English.

Later versions may change the formats of tools and automations, though stored data is meant to upgrade.

## Reporting problems

Bildora sends no telemetry, so reports from people are the only way problems are found. For each one, say what you did, what happened and what you expected, and include the text of any failure in Run history. Check that the report holds no secrets or private paths first.
