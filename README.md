# PiTech

A polished local browser UI for the real [pi coding agent](https://github.com/earendil-works/pi), created by **[Haxnstuff](https://github.com/Haxnstuff)**.

PiTech runs the actual `pi` CLI inside a hidden PowerShell ConPTY and streams it to xterm.js. Pi keeps its normal colors, sessions, keybindings, tools, and behavior—the browser is only the interface.

## Install

### Requirements

- Windows 10 or 11
- [Node.js](https://nodejs.org/) 20 or newer
- [Git](https://git-scm.com/)
- `pi` installed and available on `PATH`

Run this once in PowerShell:

```powershell
git clone https://github.com/Haxnstuff/PiTech.git "$HOME\PiTech"; Set-Location "$HOME\PiTech"; npm run setup
```

The setup command installs dependencies, vendors xterm.js, installs the PiTech bridge into `~/.pi/agent/`, detects PowerShell and `pi`, writes the local configuration, adds a hidden startup shortcut, launches PiTech, and opens `http://127.0.0.1:8787`.

Restart pi or run `/reload` after the first installation so pi loads the PiTech extension.

## Features

- Real `pi` process running in a PowerShell ConPTY
- Localhost-only server at `127.0.0.1:8787`
- Hidden server startup at Windows logon
- Reconnecting terminal with buffered output
- Resizable workspace and skills sidebars
- Project folders and drag-and-drop session collection
- Searchable past conversations with a floating session viewer
- Searchable skills with live active-state indicators
- Floating MCP, Settings, and session panels
- MCP and skill management
- Provider and API-key login controls
- Persistent pinning for projects, conversations, skills, and MCP servers
- Chrome and Firefox clipboard copy with native permission fallback
- PowerShell-style terminal right-click paste with clipboard-permission fallback
- Context-aware custom right-click menus (`Shift+right-click` opens terminal actions)
- Slate, Catppuccin Mocha, Nord, Tokyo Night, Dracula, Cyberpunk, TornTech, and Custom themes
- Conditional pi and extension update controls

## Pi integration

Setup installs:

- `pi/extensions/pi-webui.ts` → `~/.pi/agent/extensions/pi-webui.ts`
- `pi/scripts/projects.mjs` → `~/.pi/agent/scripts/projects.mjs`

The extension provides:

```text
/new-project <name>    Create a project folder
/add-project <name>    Copy the current session into a project
/project <name>        Enter a project with its other sessions in context
/project off           Leave the active project
```

It also updates `~/.pi/agent/webui-state.json` so the skills sidebar can show which skills are active in the current prompt.

## Update

```powershell
Set-Location "$HOME\PiTech"; git pull; npm run setup
```

Setup is idempotent and safe to run again.

## Manual start and stop

```powershell
# Start hidden
Set-Location "$HOME\PiTech"; wscript .\start-hidden.vbs

# Stop
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*PiTech*server.js*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

## Repository layout

| Path | Purpose |
|---|---|
| `server.js` | Local HTTP/WebSocket server and pi PTY host |
| `setup.js` | One-shot dependency, pi bridge, config, startup, and launch setup |
| `start-hidden.vbs` | Hidden Windows launcher |
| `public/` | Browser UI |
| `pi/` | Portable pi extension and shared project library |
| `tests/` | Release self-check |

`config.json`, `server.log`, dependencies, vendored browser libraries, and browser-test artifacts are generated locally and are not committed.

## Uninstall

1. Remove `pi WebUI.lnk` from `shell:startup`.
2. Delete `$HOME\PiTech`.
3. Optionally delete `~/.pi/agent/extensions/pi-webui.ts` and `~/.pi/agent/scripts/projects.mjs`.

## Firefox clipboard setup

If Firefox does not allow clipboard copy or paste, enable its asynchronous clipboard preferences:

1. Open Firefox and enter `about:config` in the address bar.
2. Accept the warning.
3. Search for `dom.events.asyncClipboard.clipboardItem` and set it to `true`.
4. Search for `dom.events.asyncClipboard.readText` and set it to `true`.
5. Reload PiTech at `http://127.0.0.1:8787`.

If either preference does not exist, create a Boolean preference with the exact name and set it to `true`.

## Attribution and license

PiTech is Copyright © 2026 **Haxnstuff** and is released under the [MIT License](LICENSE). The license requires every copy or substantial portion to retain the Haxnstuff copyright notice and permission notice. Please preserve the visible `HAXNSTUFF` signature in redistributed versions.

---

**PiTech by Haxnstuff**
