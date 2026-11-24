# Loops and calls

An automation repeats work with a loop, and reuses another automation with a Run automation block. Both are in the canvas's library: **For** and **While** under Control, and the Workspace's other automations under Automations. An automation can also be dragged from the Automations side panel onto another automation's canvas.

## Loops

A loop is a frame around the blocks it repeats, its body. The frame has the input, Next and Error like any block. Just under its header, on the left, the **body** port starts the body: its line runs down to the first block inside. A block put into a frame whose body starts nowhere yet is joined to it on its own. The blocks inside run once per round, one round at a time, and the flow goes on through Next once every round has ended.

- **For** runs its body once per item: each item of a list, such as an output value or an expression; each file of a folder that matches a pattern, such as `*.pdf`, sorted by name, with or without subfolders; or a number of times. It takes at most 1000 items, and more fail the block before the first round.
- **While** checks its condition before each round, and runs the body while it holds, so it may run no rounds at all. Its maximum number of rounds, up to 1000, is required, and reaching it with the condition still holding fails the block, so a loop never runs forever. An optional wait between rounds lets it wait until something is ready.

Loops nest: a frame can hold another loop.

The frame's header says what the loop goes through, with the values you set standing out: "Repeat ‹3› times", "For each file in ‹C:\in› matching ‹\*.pdf›", "While ‹Check1 is not completed›, at most ‹10›".

### The While condition

The condition is one yes/no [expression](expressions.md), such as:

```text
= steps.Check1.result != "completed"
= not exists(inputs.done) and loop.index < 20
= steps.Count1.outputs.files < inputs.limit
```

Under the field, the condition reads back as a sentence, and quick pieces add a block that failed, a file that exists, the rounds done, or an `and`. As you type, it suggests what it can read:

- the automation's inputs and the outputs of blocks before the loop;
- what the blocks inside left in the previous round, and how each ended, as `steps.<block>.result`. On the first check no round has run yet, so outputs read as empty values (empty text, 0, no, an empty list), and results read `skipped`;
- `loop.index`, which here is the number of rounds done, 0 on the first check.

### Building a loop

- Add a loop from the library. With a loop selected, the next block added from the library goes inside it, joined to its body. Select a block inside the frame to go on there, or the loop itself to go on after it.
- Drag a block onto a frame to put it in the loop, and off the frame to take it out. Blocks always connect within one frame, so a move that would make a connection cross a frame is refused, and the block goes back. Disconnect it first, or move the blocks it is connected to with it.
- Dragging a frame by its header moves everything inside it. Deleting a loop keeps the blocks that were inside, in the loop around it if there is one.
- A selected frame has a small square at each corner that makes it bigger in that direction, to leave room for blocks to come. It never gets smaller than the blocks inside it, still grows when they go past it, and keeps its place and size in the file, also when it is moved.
- Copying a loop copies the blocks inside it too.

### Values inside a loop

| Name          | What it reads                                                        |
| ------------- | -------------------------------------------------------------------- |
| `loop.item`   | The round's item: a list item, a file's path, or the round's number  |
| `loop.index`  | The round's number, from 1                                           |
| `loop.folder` | A folder of the round's own, inside the run's folder                 |
| `For1.item`   | The same for any loop around the block, by its name, in nested loops |

`run.folder` stays the same for the whole run. A block inside a loop reads the blocks before the loop, and only the current round of the blocks inside it.

### Values after a loop

After the loop, an output of a block inside it reads as a list with one value per round, such as `= steps.Convert1.outputs.file`. A round where that block produced nothing, because its path was not taken or the round failed, gives an empty text, so a position in the list is a round's number. `compact()` drops the empty ones. A list read after nested loops is flat, in the order the rounds ran. Lists hold text, so numbers become text.

The loop itself has a `rounds` output: `= steps.For1.outputs.rounds`. After a loop that ran no rounds, the outputs of its blocks are empty lists.

### When a round fails

By default, a failure inside the body that nothing handles ends the loop and fails the loop block, whose Error output can handle it. The loop's **If a round fails** setting can go on with the next round instead: the loop then runs every round, and fails at the end if any round failed.

## Calling another automation

A **Run automation** block runs another automation of the same Workspace. Add one from the library, or drag an automation from the Automations side panel onto the canvas; an automation dropped onto its own canvas is refused, since it would call itself. Its fields are the inputs of the called automation's Start block, and take links and expressions like any value. **Go to automation**, or a double-click on the block, opens the called automation in its tab.

A called automation declares nothing for its caller. The caller reads any output of any of its blocks, with the Run automation block's name first:

```text
= steps.Report1.Extract1.outputs.result.total
= steps.Report1.Archive1.Copy1.outputs.file
```

The second reads through a call inside the call. As within one automation, an output can be read only if its block runs on every path of the called automation. Link to, the suggestions and the pick-whip offer these outputs.

- The called run has its own run folder and its own entry in Run history, linked to the run that called it.
- If it fails, the Run automation block fails, and its Error output can handle that. Cancelling one run cancels the other.
- When a run starts, Bildora reads every automation it can call. It refuses an automation that ends up calling itself, and calls at most 5 levels deep, the first automation included.
- Renaming a block that other automations read through a call offers to update them, naming each one. Saved automations are written again; one open in a tab is updated there and keeps its unsaved changes. Undo in the renamed automation does not take those updates back.

## Watching a run

- A loop's header shows "‹ Round 3 / 12 ›", and the blocks inside show the state and data of that round. While a run goes on, it follows the latest round until you pick one. A dot per round, colored by how it went, jumps to it, so a failed round is easy to find.
- Selecting a Run automation block that ran shows **Open run**, which opens the called run in its automation's tab, as a double-click on the block does. That run shows **Called by**, which leads back.
- Run history lists each round of a block as its own row, named by its round, and a called run names the run that called it.

`bildora run` names the round of a step inside a loop, and starts the lines of a called run with its automation's name:

```text
[1/2] For1: completed (2.1 s, 2 rounds)
  one (round For1:2): running
Calling "Child" from Child1.
Child › [1/1] inner: running
```

## In the file

A block inside a loop names it with `loop`, and the body starts at the loop's `body` output:

```yaml
blocks:
  - { id: start, type: start }
  - id: For1
    type: for
    items: { kind: folder, folder: 'C:\in', pattern: '*.pdf' }
    onRoundFailure: continue
  - { id: Convert1, type: run, tool: acme.convert, loop: For1 }
  - id: While1
    type: while
    maxRounds: 30
    waitSeconds: 10
    condition: { expression: 'steps.Check1.result != "completed"' }
  - { id: Check1, type: run, tool: acme.check, loop: While1 }
  - id: Report1
    type: run-automation
    automation: report
    inputs: { files: { expression: compact(steps.Convert1.outputs.file) } }
connections:
  - { from: start, to: For1 }
  - { from: For1, output: body, to: Convert1 }
  - { from: For1, to: While1 }
  - { from: While1, output: body, to: Check1 }
  - { from: While1, to: Report1 }
```

For takes `items` of kind `list` (with `list`, an expression), `folder` (with `folder`, and optional `pattern` and `subfolders`) or `count` (with `count`, a number or an expression). While takes its `condition` as an expression. An automation holds up to 200 blocks, those inside loops included.

A frame made bigger keeps its size with the loop's position:

```yaml
positions:
  For1: { x: 240, y: -40, width: 520, height: 300 }
```
