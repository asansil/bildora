# Log Folder

Scans every `.log` file of a folder, one round each, and writes a note per log into a `reports`
folder beside them, then a `summary.txt` with how many logs it scanned. Other files are left alone.

- **EachLog** is a For over the files of the folder that match `*.log`, sorted by name.
- **Scan** and **Note**, inside the loop, read the round's file as `loop.item`; Scan keeps its JSON
  output in the round's own folder, `loop.folder`.
- **Summary**, after the loop, reads how many rounds ran from `steps.EachLog.outputs.rounds`.

Run it from the command line with:

```
bildora run log-folder --input logs=C:\path\to\logs
```
