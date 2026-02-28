# Glass

Desktop AI overlay assistant (Electron) for context-aware Q&A, voice input, and meeting workflows.

## Features

- Desktop overlay with fast show/hide and click-through modes.
- Ask model using recent screen/audio context.
- Voice input with selectable STT model.
- Configurable global shortcuts.
- Multiple LLM/STT backends (OpenAI, Gemini, local options where configured).

## Recent Fixes (This Version)

- OpenAI requests migrated to Responses API flow (including streaming path).
- Added/updated GPT family support: `gpt-5.2`, `gpt-5`, `gpt-5-mini`.
- Updated STT options include `gpt-4o-transcribe` and `gpt-4o-mini-transcribe`.
- Added reasoning effort setting (`low` / `medium` / `high` / `xhigh`) and wired it into LLM requests.
- Improved shortcut system stability:
  - show/hide default is `Ctrl+Alt+H` (Windows)
  - alias `Ctrl+\` supported for show/hide
  - fixed invalid accelerator parsing for `Backslash` in shortcut editor
  - fixed re-register flow so show/hide alias is not lost after window/state changes

## Requirements

- Node.js `20.x`
- npm `10+`
- Python `3.x`
- Windows: Visual Studio Build Tools (for native deps)

## Quick Start

```bash
npm run setup
```

After setup, app starts once automatically. Next launches:

```bash
npm start
```

## Build

Windows build:

```bash
npm run build:win
```

All platforms (depending on host/tooling):

```bash
npm run build
```

## Hidden Launch (Windows)

Use `Start-Glass-Hidden.vbs` for silent start without console window.

- First tries portable build: `dist\\Glass Portable.exe`
- Then unpacked build: `dist\\win-unpacked\\Glass.exe`
- Fallback: source run via `npm start` in background

Detailed guide (RU): [docs/HIDDEN-LAUNCH-RU.md](docs/HIDDEN-LAUNCH-RU.md)

## Logs and Troubleshooting

- Hidden launcher log: `start-glass.log`
- Runtime logs: `run.log`, `run2.log`, `run-new.log` (if present)

If app does not open:

1. Check Node version (`node -v`) and dependencies (`npm install`).
2. Run once in foreground: `npm start`.
3. Inspect `start-glass.log` for launcher errors.

## Keyboard Shortcuts

Shortcuts can be changed in Settings -> Edit Shortcuts.

- Show/Hide: default `Ctrl+Alt+H`
- Show/Hide alias: `Ctrl+\`
- Ask: default `Ctrl+Alt+A`
- Listen Start/Stop: see Settings
- Scroll response up/down: see Settings

Alias support for alternative keys depends on OS keyboard layout and global shortcut capture limits.

## Security Notes

- Do not commit secrets (`.env`, API keys, local config dumps).
- Keep personal config outside git-tracked files.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

GPL-3.0
