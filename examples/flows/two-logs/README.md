# Two Logs

Scans an app log and a web log at the same time, then writes `summary.txt` beside the app log. When
the web log cannot be read, it writes `web-missing.txt` instead of stopping.

- **Both** is a Parallel: **ScanApp** and **ScanWeb** run at once, each on its own branch.
- **ScanWeb**'s Error output leads to **WebMissing**, so its failure is handled and the run goes on.
- **Meet** is the Join that ends both branches; **Summary** runs once every branch has finished.

A run where the web log is missing finishes as completed, saying that one step failed, and the
command exits with code 3.

Run it from the command line with:

```
bildora run two-logs --input app=C:\logs\app.log --input web=C:\logs\web.log
```
