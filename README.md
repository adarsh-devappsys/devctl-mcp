# devctl-mcp

An MCP (Model Context Protocol) server that lets Claude manage long-running dev processes seamlessly — across Flutter, Next.js, Spring Boot, Vite, and any custom stack.

**The problem it solves:** When Claude spawns `flutter run`, `next dev`, or `gradle bootRun` via bash, it immediately loses control. No hot reload, no log access, no restart. This server runs as a persistent daemon that owns all dev processes and exposes simple tools Claude can call.

---

## Features

- **Flutter** — auto-detect FVM, target specific devices, hot reload & hot restart via Dart VM service
- **Next.js** — auto-detect package manager (npm / pnpm / yarn / bun) from lockfiles
- **Spring Boot** — auto-detect Maven or Gradle, use `mvnw`/`gradlew` wrappers when present
- **Vite / React** — detect `vite.config.*` or `react-scripts` in `package.json`
- **Generic** — run any custom command with full log capture
- **Log streaming** — circular buffer (1000 lines), filter by string, timestamps on demand
- **Full process lifecycle** — start, stop, restart with status tracking (starting → running → stopped/crashed)

---

## Installation

### Prerequisites

- Node.js 20+
- Claude Code CLI

### Setup

```bash
git clone git@github.com:adarsh-devappsys/devctl-mcp.git
cd devctl-mcp
npm install
npm run build
```

### Register globally with Claude Code

```bash
claude mcp add -s user devctl -- node /absolute/path/to/devctl-mcp/dist/index.js
```

Verify it's connected:

```bash
claude mcp list
# devctl: node .../dist/index.js - ✓ Connected
```

> The server will be available in all your Claude Code sessions globally.

### Project-level (alternative)

The repo ships with a `.mcp.json` — if you open this repo in Claude Code, it's auto-loaded without any extra setup.

---

## Available Tools

### Core — works for all frameworks

| Tool | Description |
|---|---|
| `list_processes` | List all managed processes with status, uptime, PID |
| `start_process` | Start a dev server — auto-detects the framework |
| `stop_process` | Gracefully stop a process (SIGTERM → SIGKILL after 5s) |
| `restart_process` | Stop + restart with original configuration |
| `get_logs` | Get recent log output, with optional line count and filter |
| `clear_logs` | Clear the log buffer for a process |
| `send_input` | Send raw text to process stdin (escape hatch) |

### Flutter-specific

| Tool | Description |
|---|---|
| `flutter_hot_reload` | Hot reload via Dart VM service, falls back to stdin `r` |
| `flutter_hot_restart` | Hot restart via Dart VM service, falls back to stdin `R` |
| `list_devices` | List connected Flutter devices and emulators |

---

## Usage Examples

### Flutter

```
List my connected Flutter devices
```
```
Start my Flutter app at /Users/me/projects/myapp, name it "myapp", on my Pixel device
```
```
Hot reload myapp
```
```
Hot restart myapp
```
```
Get the last 100 logs from myapp, filter by "error"
```

**With FVM (auto-detected):**

If your project has `.fvm/flutter_sdk` or `fvm_config.json`, FVM is used automatically. You can also force it:

```
Start myapp at /path/to/project with use_fvm true, device id "32211JEHN06807"
```

### Next.js

```
Start the Next.js project at /Users/me/projects/website, name it "web"
```

Package manager is auto-detected from lockfiles (`bun.lockb` → bun, `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, else npm). Override with `package_manager: "pnpm"`.

### Spring Boot

```
Start /Users/me/projects/api, name it "api"
```

Maven vs Gradle auto-detected from `pom.xml` / `build.gradle`. Uses `./mvnw` or `./gradlew` wrappers when present.

### Any other stack

```
Start /Users/me/projects/backend, name it "django", command "python manage.py runserver"
```

### Checking logs

```
Show me the logs for myapp
```
```
Get last 50 lines from api, filter by "Exception"
```
```
Get logs from web with timestamps
```

---

## Framework Auto-Detection

The adapter is chosen automatically based on what's in your project directory:

| Framework | Detection |
|---|---|
| Flutter | `pubspec.yaml` exists |
| Spring Boot | `pom.xml` or `build.gradle` / `build.gradle.kts` |
| Next.js | `package.json` with `next` in dependencies |
| Vite | `vite.config.*` file, or `vite`/`react-scripts` in `package.json` |
| Generic | Fallback — requires `command` option |

Priority: Flutter → Spring Boot → Next.js → Vite → Generic

### FVM Auto-Detection (Flutter)

FVM is auto-enabled when **both** are true:
1. `fvm` binary is in `PATH`
2. Project has `.fvm/flutter_sdk`, `fvm_config.json`, or `.fvmrc`

Override: pass `use_fvm: true` or `use_fvm: false` explicitly.

### Package Manager Auto-Detection (JS projects)

Detected from lockfiles in priority order:
1. `bun.lockb` → bun
2. `pnpm-lock.yaml` → pnpm
3. `yarn.lock` → yarn
4. Fallback → npm

---

## How Flutter Hot Reload Works

The server uses a two-tier system for maximum reliability:

**Tier 1 — Dart VM service (preferred)**

When `flutter run` starts, it prints a line like:
```
A Dart VM Service on Pixel 7a is available at: http://127.0.0.1:56789/TOKEN=/
```

The server captures this URL and derives a WebSocket endpoint. Hot reload/restart is sent as JSON-RPC over WebSocket — the same protocol Flutter DevTools uses.

Hot reload sequence: `getVM` → `reloadSources` → `callServiceExtension('ext.flutter.reassemble')`

Hot restart sequence: `getVM` → `callService('hotRestart')`

**Tier 2 — stdin fallback**

If the VM service URL isn't available yet (app still starting up), the server sends `r` or `R` to the process stdin — Flutter's interactive keyboard commands.

---

## Development

```bash
# Run without building (tsx watches for changes)
npm run dev

# Build
npm run build

# Type-check only
npm run typecheck
```

---

## Project Structure

```
src/
  index.ts              ← MCP server entry, stdio transport
  types.ts              ← Shared TypeScript interfaces
  process-manager.ts    ← Process registry, spawn, lifecycle, VM service URL parsing
  log-store.ts          ← Circular buffer (1000 lines, stdout + stderr + timestamps)
  adapters/
    flutter.ts          ← Flutter + FVM detection
    nextjs.ts           ← Next.js + package manager detection
    spring-boot.ts      ← Maven/Gradle + wrapper detection
    vite.ts             ← Vite/React-scripts detection
    generic.ts          ← Fallback for custom commands
    registry.ts         ← Ordered detection chain
  tools/
    process-tools.ts    ← 7 core MCP tools
    flutter-tools.ts    ← Flutter hot reload/restart + list_devices
```

---

## Important Notes

- **Session persistence:** Managed processes live as long as the Claude Code session is open. If you close the session, running processes are stopped. This is a fundamental constraint of the stdio MCP transport.
- **stdout is reserved:** The MCP protocol uses `process.stdout` for JSON-RPC messages. All internal server logs go to `stderr`.
- **PATH inheritance:** The server inherits your shell `PATH`, so `fvm`, `flutter`, `mvn`, `gradle`, etc. must be on your PATH as they would be in a terminal.
