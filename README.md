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
  - added `Close Extra Windows` shortcut (keeps only main menu/header visible)
  - fixed invalid accelerator parsing for `Backslash` in shortcut editor
  - fixed re-register flow so show/hide alias is not lost after window/state changes

## Requirements

- Node.js `20.x`
- npm `10+`
- Python `3.x`
- Windows: Visual Studio Build Tools (for native deps)

## Windows: Full Clone/Install/Run Guide

Repository:

`https://github.com/AxoRm/glass`

### 1) Install prerequisites (Windows)

Install:

- Git for Windows: https://git-scm.com/download/win
- Node.js 20.x LTS: https://nodejs.org/en/download
- Python 3.x: https://www.python.org/downloads/windows/
- Visual Studio Build Tools: https://visualstudio.microsoft.com/visual-cpp-build-tools/

For Build Tools installer, enable:

- `Desktop development with C++`
- MSVC v143 build tools
- Windows 10/11 SDK

Verify in terminal:

```bash
git --version
node -v
npm -v
python --version
```

### 2) Clone project

```bash
git clone https://github.com/AxoRm/glass.git
cd glass
```

### 3) Install dependencies and first run

```bash
npm run setup
```

This installs root/web dependencies, builds web/renderer, and starts app once.

Next normal runs:

```bash
npm start
```

### 4) Configure API key in app

Open Settings in the app and set your provider API key (OpenAI/Gemini/etc.), then choose LLM/STT models.

### 5) Build Windows app (recommended for best hidden launch)

```bash
npm run build:win
```

Expected outputs:

- `dist\\Glass Portable.exe`
- or `dist\\win-unpacked\\Glass.exe`

### 6) Hidden launcher (silent startup without console)

Use `Start-Glass-Hidden.vbs` (double click).

Launcher order:

1. Runs `dist\\Glass Portable.exe` if present
2. Else runs `dist\\win-unpacked\\Glass.exe`
3. Else falls back to background source run (`npm start`) and writes log

Logs:

- `start-glass.log` for hidden launcher
- `run.log` / `run2.log` / `run-new.log` for runtime (if present)

### 7) Add hidden launch at Windows startup (optional)

1. `Win + R`
2. Run `shell:startup`
3. Put shortcut to `Start-Glass-Hidden.vbs` there

### 8) Updating to latest version

Inside project folder:

```bash
git pull
npm install
npm run build:renderer
```

Then restart app. If dependencies changed significantly, run `npm run setup` once.

### 9) Troubleshooting on Windows

If app does not start:

1. Run foreground mode once: `npm start`
2. Check `start-glass.log`
3. Ensure Node is `20.x`
4. Reinstall deps: `npm install`
5. Rebuild renderer: `npm run build:renderer`

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
- Close Extra Windows (leave only main menu): default `Ctrl+Alt+M`
- Scroll response up/down: see Settings

Alias support for alternative keys depends on OS keyboard layout and global shortcut capture limits.

## Security Notes

- Do not commit secrets (`.env`, API keys, local config dumps).
- Keep personal config outside git-tracked files.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

GPL-3.0
