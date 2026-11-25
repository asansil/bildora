# Links and expressions

A value in a block can follow another value instead of holding its own. Type `=` at the start of a field, and what follows is a link or an expression:

| Value                                        | Meaning                                       |
| -------------------------------------------- | --------------------------------------------- |
| `= convert.file`                             | The `file` setting of the block `convert`     |
| `= inputs.file`                              | The automation's `file` input                 |
| `= steps.check.outputs.summary.lines`        | A value the block `check` produced            |
| `= convert.width * 2`                        | Worked out from other values                  |
| `= name(inputs.file) + "_thumb.png"`         | A path function and joined text               |
| `= iif(inputs.size > 100, "large", "small")` | A comparison, and a choice between two values |

The field shows what the value resolves to as the flow stands, or says that it is worked out when the automation runs. Expressions work in every kind of field: text, paths, numbers, yes-or-no and choices.

## Making a link without typing

- Right-click a field and choose **Link to**. It lists the automation's inputs, the values of the loops around the block, the results of earlier blocks, those of automations that Run automation blocks call, and the settings of other blocks. Values that do not fit the field are shown, but cannot be chosen.
- Drag the target beside a field onto a block, and choose one of that block's values.
- **Unlink**, in the same menu, keeps the value the link resolved to as the field's own value.
- **Go to**, in the same menu, selects the block a link follows.

A block whose settings or results other blocks use shows how many on its top edge. Pressing that mark, or **Ctrl+F** on the canvas, finds them.

## Names

Each block's name is its label on the canvas, such as `FileCheck1`, and links use it: `= FileCheck1.file`. New blocks are numbered from 1. Renaming a block, with **F2**, from its menu or by right-clicking its name in the settings, changes every link, expression, reference and rule that names it. Copying and pasting blocks keeps links between the copies. Deleting a block leaves the links to it in place, and the automation cannot run until they are fixed, so undoing the delete brings everything back.

| Name                                     | What it reads                                                                      |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| `<block>.<setting>`                      | What the block is set to: its own value, then its profile, then the tool's default |
| `inputs.<name>`                          | An input of the automation, declared on its Start block                            |
| `steps.<block>.outputs.<output>`         | An output of a block that ran before                                               |
| `steps.<block>.outputs.<output>.<field>` | A field of a JSON output                                                           |
| `steps.<call>.<block>.outputs.<output>`  | An output of a block of the automation a Run automation block called               |
| `steps.<loop>.outputs.rounds`            | How many rounds a loop ran                                                         |
| `steps.<block>.result`                   | How a block ended: `completed`, `failed`, or `skipped` when it did not run         |
| `loop.item`, `loop.index`, `loop.folder` | The item, the round's number from 1, and the round's folder of the nearest loop    |
| `<loop>.item`                            | The same for any loop around the block, by its name                                |
| `run.folder`                             | The folder this run keeps to itself                                                |
| `paths.<name>`                           | A path variable of this computer                                                   |

`inputs`, `steps`, `run`, `paths` and `loop` start these names, so no block can be called by them.

A link to a setting reads what that block is set to, wherever it sits in the flow: before or after, on another branch, or on a path the run never takes. It follows chains of links. A link cannot lead back to itself, and a secret setting cannot be linked, because it would carry a secret into a shared file.

An output only exists once its block has run. A value that reads one needs that block to finish on every path that reaches the block using it, as earlier references do.

Inside a loop, a block reads the round going on. After the loop, an output of a block inside it is a list with one value per round, and an empty text for a round where the block left nothing. [Loops and calls](loops-and-calls.md) explains both, and how values come back from a called automation.

Block names may contain `-`, so `convert-2.file` is one name. Put spaces around a minus that subtracts: `convert.width - 1`.

## Values

- Numbers: `2`, `0.5`.
- Text in double quotes: `"thumb"`. Inside, `\"` is a quote, `\\` a backslash, `\n` a new line and `\t` a tab.
- Yes or no: `true`, `false`.
- Parentheses group: `(a.width + 10) * 2`.

## Operators

| Operator          | Works on                       | Gives                                             |
| ----------------- | ------------------------------ | ------------------------------------------------- |
| `+`               | Numbers, or text with anything | A sum, or the two joined as text                  |
| `-` `*` `/` `%`   | Numbers                        | Arithmetic. `/` gives decimals, `%` the remainder |
| `==` `!=`         | Two values of the same kind    | Yes or no                                         |
| `<` `<=` `>` `>=` | Two numbers, or two texts      | Yes or no                                         |
| `and` `or` `not`  | Yes or no                      | Yes or no                                         |

`*` and `/` come before `+` and `-`, which come before comparisons, then `not`, `and` and `or`. Comparisons cannot be chained: write `a > 1 and a < 5`.

## Functions

| Function                      | Gives                                                                              | Example                                       |
| ----------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------- |
| `name(path)`                  | The file name with its extension                                                   | `name("C:\data\photo.png")` is `photo.png`    |
| `stem(path)`                  | The file name without its extension                                                | `photo`                                       |
| `ext(path)`                   | The extension, with its dot                                                        | `.png`                                        |
| `folder(path)`                | The folder that holds it                                                           | `C:\data`                                     |
| `join(path, name, …)`         | Parts joined into one path                                                         | `join(run.folder, "out", "a.csv")`            |
| `upper(text)`                 | Text in capitals                                                                   |                                               |
| `lower(text)`                 | Text in small letters                                                              |                                               |
| `trim(text)`                  | Text without spaces at either end                                                  |                                               |
| `replace(text, find, put)`    | Text with every `find` replaced by `put`                                           | `replace(a.title, " ", "_")`                  |
| `text(value)`                 | Any value as text                                                                  | `text(a.width)`                               |
| `number(text)`                | Text read as a number                                                              | `number("12.5")`                              |
| `round(number)`               | The nearest whole number                                                           | `round(2.5)` is `3`                           |
| `round(number, decimals)`     | Rounded to that many decimals, 0 to 15                                             | `round(2.567, 2)` is `2.57`                   |
| `min(a, b, …)` `max(a, b, …)` | The smallest or largest number                                                     |                                               |
| `length(value)`               | Characters in a text, or items in a list                                           | `length(steps.check.outputs.summary.tooLong)` |
| `compact(list)`               | The list without its empty items, such as the rounds where a block left nothing    | `compact(steps.Convert1.outputs.file)`        |
| `contains(value, part)`       | Whether a text holds `part`, or a list holds it as an item                         |                                               |
| `starts(text, part)`          | Whether the text starts with `part`                                                |                                               |
| `ends(text, part)`            | Whether the text ends with `part`                                                  | `ends(inputs.file, ".csv")`                   |
| `iif(condition, yes, no)`     | `yes` when the condition holds, `no` otherwise. Only the chosen side is worked out | `iif(a.fast, 1, 4)`                           |
| `exists(path)`                | Whether a file or folder is there, looked at when the value is worked out          | `not exists(join(run.folder, "done"))`        |

Path functions treat `\` and `/` alike, as Windows does.

## Types

Bildora checks every expression before a run, and a problem names the block and the field. A value fits a field when:

- a text field takes text, a path, a number or yes-or-no, written as text;
- a path or a choice field takes text or a path;
- a whole-number field takes a whole number;
- a number field takes any number;
- a yes-or-no field takes yes or no.

Some things can only go wrong when the automation runs: dividing by zero, `number` on text that is not a number, a choice that is not one of the field's choices, or a decimal number for a whole-number field. The block then fails, and follows its failure policy.

## Conditions

A While goes on while one yes/no expression holds; see [Loops and calls](loops-and-calls.md#the-while-condition). An If or a Switch decides with rules. A rule can read a block's result or exit code, or **a value**: an input, a result of an earlier block, a setting of another block, or an expression. Its operators fit what it reads:

| What it reads | Operators                                                            |
| ------------- | -------------------------------------------------------------------- |
| A number      | is, is not, greater than, less than, at least, at most               |
| Text          | is, is not, contains, starts with, ends with, is empty, is not empty |
| A path        | As text, and exists, does not exist                                  |
| Yes or no     | is yes, is no, is, is not                                            |
| A list        | contains, is empty, is not empty                                     |

What a rule compares with can be typed, or start with `=` to be a link or an expression.

## In the file

An automation file keeps a link or an expression apart from plain text, without its `=`:

```yaml
values:
  file: { expression: inputs.file }
  width: { expression: convert.width * 2 }
  title: 'A plain text value'
```

Plain text values keep `{{...}}` references, such as `'{{run.folder}}/report.csv'`, as earlier versions wrote them.

## Safety

Expressions only work out values. They cannot read files, reach the network, see the environment or run anything, and they have no loops of their own, so sharing an automation adds no way to run anything beyond its tools. An expression is at most 2000 characters, nests at most 32 levels deep, and a text it works out is at most 100,000 characters.
