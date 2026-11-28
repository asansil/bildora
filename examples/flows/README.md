# Reference flows

Each folder holds an automation that shows one kind of flow, with a README saying what it does.
The tools they run are in `tools/`, one folder per tool named by its id, as small Node scripts
with a level 1 manifest.

To try one, copy the folders of `tools/` into the `tools` folder of Bildora's data, and the
automation file into the `automations` folder of a workspace.

| Flow                      | Shows                                                              |
| ------------------------- | ------------------------------------------------------------------ |
| [Log Check](log-check/)   | An If that decides on a JSON output                                |
| [Log Folder](log-folder/) | A For over the files of a folder                                   |
| [Two Logs](two-logs/)     | Parallel branches and an Error output                              |
| [Log Notes](log-notes/)   | Blocks that share an input and read each other through expressions |

The end-to-end tests run every flow from the app and from the command line.
