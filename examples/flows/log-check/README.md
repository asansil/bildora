# Log Check

Scans a log file and writes a note beside it: `<log>-errors.txt` with the number of errors when the
log holds any, `<log>-ok.txt` when it holds none.

- **Scan** runs Scan Log, which writes its counts to a JSON output in the run's own folder.
- **HasErrors** is an If whose rule reads the `errors` field of that output.
- **Report** and **AllClear** run Write Note on the path the If takes; the other one is skipped.

Run it from the command line with:

```
bildora run log-check --input log=C:\path\to\app.log
```
