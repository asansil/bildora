# Log Notes

Writes two notes beside a log, named with a tag the run is given: `<log>-<tag>.txt` with the number
of errors, and `<log>-<tag>-warnings.txt` with the number of warnings.

- **Scan** and **Errors** share the automation's `log` input: Scan reads it, and Errors builds its
  note's name from it and from the `tag` input.
- **Errors** and **Warnings** name the log through Scan's own setting, `= Scan.file`.
- **Warnings** names its note after Errors' setting, `= replace(Errors.file, ".txt", "-warnings.txt")`,
  so changing how Errors names its note changes both.

Each block that other blocks read shows how many on its top edge, and renaming a block updates every
expression that names it.

Run it from the command line with:

```
bildora run log-notes --input log=C:\logs\app.log --input tag=monday
```
