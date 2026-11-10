# Returning values from a tool

A level 1 tool can hand values to the automations that run it. It writes a JSON file, and its manifest declares the file and the fields in it. Bildora reads the file when the tool ends, checks every field against its declared type, and offers the fields to later blocks: in a value, such as `= steps.check.outputs.summary.lines`, and in the rules of an If or a Switch.

The tool needs nothing from Bildora to do this. Run by hand, it writes the same file, and a person can open it.

The sample in [`examples/level-1-file-check`](../examples/level-1-file-check) does all of this in about thirty lines.

## Declaring the file

Add an output with `json` and `fields` to the manifest:

```yaml
outputs:
  - name: summary
    description: What the check found.
    json: '{{params.out}}/summary.json'
    fields:
      - { name: lines, type: integer, description: Lines in the file. }
      - { name: empty, type: boolean }
      - { name: tooLong, type: list }
      - { name: name, type: string }
```

- `json` is where the file is. It can use the values the tool ran with, as `{{params.<name>}}`, and path variables, as `{{paths.<name>}}`. A relative path is read from the folder of the tool's program. Give the tool a parameter for its output folder, and point an automation at the run's own folder with `= run.folder`.
- `fields` lists what the file holds, from 1 to 100 fields. Each has a `name`, a `type` and an optional `description` for people reading the manifest.

| Type      | JSON value                       |
| --------- | -------------------------------- |
| `string`  | Text                             |
| `path`    | Text that names a file or folder |
| `integer` | A whole number                   |
| `number`  | Any number                       |
| `boolean` | `true` or `false`                |
| `list`    | An array of texts, up to 10,000  |

The output itself, without a field, is the path of the file, so a later tool can read the whole file: `= steps.check.outputs.summary`.

## Writing the file

Write one JSON object, with every declared field:

```json
{ "lines": 3, "empty": false, "tooLong": ["2"], "name": "notes.txt" }
```

Fields the manifest does not declare are ignored, so a tool can add more for people to read.

## What fails the block

The tool's exit code still decides whether it succeeded. When it exits with 0, its block also fails, with a message that says why, if:

- the file is not there;
- it is larger than 1 MiB;
- it is not valid JSON, or not one object;
- a declared field is missing, or holds another type of value.

A block that fails follows its failure policy, as any failed block does: it stops the automation, retries, or leads to its Error output.

## Secret fields

Mark a text field `secret: true` when it holds something that must not be kept:

```yaml
- { name: token, type: string, secret: true }
```

Bildora leaves a secret field out of run history, where it shows only that the field was there, and no block of an automation can read it, because automations are shared. A tool that also prints the value to its console is beyond this protection. Only text fields can be secret.

## Other outputs

The earlier kinds of output still work:

- `param: <parameter>` is the value the tool ran with for that parameter, such as the file it was told to write. It is a path when the parameter is one, and text otherwise.
- `path: <path>` is a fixed path, relative to the tool's folder, which may use path variables.

## Checking your manifest

The JSON Schema for manifests, `tool-manifest.schema.json`, describes JSON outputs too, so an editor that reads JSON Schema can check the manifest as you write it. Bildora checks the rest when it imports the tool: field names must be unique, and only text fields can be secret.
