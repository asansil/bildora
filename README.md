# Bildora

Bildora is a desktop app for Windows that gathers the programs and scripts scattered around your
machine, runs them from one place, and chains them into automations.

- Bring in any program or script: a `.exe`, `.py`, `.bat` or similar.
- Give a script a generated form, a live console, saved profiles and run history with a
  `tool.yaml` beside it, without changing the script.
- Keep secret values in the Windows credential store, out of files and run history.
- Separate work into Workspaces, each with its own tools, automations, history and layout.
- Build automations on a canvas, and run them with no window open through the `bildora` command.

## Status

Bildora is in early development and has no published version yet. The `main` branch holds
released versions only; work in progress lives on `develop`.

## Building from source

Requires Windows, Node.js 24 and pnpm.

```sh
pnpm install
pnpm build
pnpm --filter @bildora/desktop dev
```

## License

[Apache License 2.0](LICENSE)
