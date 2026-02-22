# @squidcode/forever-plugin

MCP (Model Context Protocol) plugin for [Forever](https://forever.squidcode.com) — a centralized persistent memory layer for Claude Code instances.

Forever lets multiple Claude Code sessions share memory and files across machines, projects, and time. This plugin connects Claude Code to your Forever server via MCP.

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- A Forever account ([register here](https://forever.squidcode.com/register))

## Setup

### 1. Authenticate

```bash
npx @squidcode/forever-plugin login
```

This opens your browser for authentication (similar to `gh auth login`):

1. A verification code is displayed in your terminal (e.g. `ABCD-EF23`)
2. Your browser opens to `https://forever.squidcode.com/auth/device`
3. Log in if needed, then confirm the code matches and click **Authorize**
4. The plugin receives your token automatically — no passwords in the terminal

Credentials are saved to `~/.forever/credentials.json` (mode 0600).

On successful login, Forever instructions are automatically added to `~/.claude/CLAUDE.md` so Claude Code knows how to use the memory tools.

### 2. Add to Claude Code

```bash
claude mcp add forever -- npx @squidcode/forever-plugin
```

This registers the plugin as an MCP server that Claude Code will start automatically.

## CLI Commands

```
npx @squidcode/forever-plugin <command>
```

| Command            | Description                                            |
|--------------------|--------------------------------------------------------|
| `login`            | Authenticate with Forever (device auth flow)           |
| `install`          | Add Forever instructions to `~/.claude/CLAUDE.md`      |
| `install --force`  | Add instructions even if already present               |
| `help`             | Show help message                                      |

Without a command, the plugin starts in MCP server mode (used by Claude Code internally).

## Tools

The plugin exposes the following MCP tools:

### Memory Tools

#### `memory_log`

Log an entry to Forever memory.

| Parameter   | Type     | Required | Description                          |
|-------------|----------|----------|--------------------------------------|
| `project`   | string   | no       | Project name or git remote URL (auto-detected) |
| `type`      | enum     | yes      | `summary`, `decision`, or `error`    |
| `content`   | string   | yes      | The content to log                   |
| `tags`      | string[] | no       | Tags for categorization              |
| `sessionId` | string   | no       | Session ID for grouping entries      |

#### `memory_get_recent`

Get recent memory entries for a project.

| Parameter | Type   | Required | Description                    |
|-----------|--------|----------|--------------------------------|
| `project` | string | no       | Project name or git remote URL (auto-detected) |
| `limit`   | number | no       | Number of entries (default 20) |

#### `memory_get_sessions`

Get recent sessions grouped by session with machine info. Use at startup to detect cross-machine handoffs.

| Parameter | Type   | Required | Description                    |
|-----------|--------|----------|--------------------------------|
| `project` | string | no       | Project name or git remote URL (auto-detected) |
| `limit`   | number | no       | Number of sessions (default 10) |

#### `memory_search`

Search memory entries across projects.

| Parameter | Type   | Required | Description            |
|-----------|--------|----------|------------------------|
| `query`   | string | yes      | Search query           |
| `project` | string | no       | Filter by project      |
| `type`    | enum   | no       | Filter by entry type   |
| `limit`   | number | no       | Max results (default 20) |

### File Tools

#### `memory_store_file`

Store a file in Forever for cross-machine access.

| Parameter  | Type   | Required | Description                     |
|------------|--------|----------|---------------------------------|
| `filePath` | string | yes      | Path to the file (relative or absolute) |
| `project`  | string | no       | Project name (auto-detected)    |

#### `memory_restore_file`

Restore a file from Forever to the local disk.

| Parameter  | Type   | Required | Description                     |
|------------|--------|----------|---------------------------------|
| `filePath` | string | yes      | Path of the file to restore     |
| `project`  | string | no       | Project name (auto-detected)    |

#### `memory_share_file`

Mark a file for auto-sync across machines (also stores it immediately).

| Parameter  | Type   | Required | Description                     |
|------------|--------|----------|---------------------------------|
| `filePath` | string | yes      | Path to the file to share       |
| `project`  | string | no       | Project name (auto-detected)    |

#### `memory_unshare_file`

Stop auto-syncing a file across machines.

| Parameter  | Type   | Required | Description                     |
|------------|--------|----------|---------------------------------|
| `filePath` | string | yes      | Path of the file to stop sharing |
| `project`  | string | no       | Project name (auto-detected)    |

#### `memory_sync_files`

Sync all shared files for a project — downloads newer versions, uploads local changes.

| Parameter | Type   | Required | Description                  |
|-----------|--------|----------|------------------------------|
| `project` | string | no       | Project name (auto-detected) |

## How It Works

- The plugin runs as an MCP stdio server, started by Claude Code on demand.
- Each machine gets a unique ID (stored in `~/.forever/machine.json`) for tracking which machine produced each memory entry.
- All API calls are authenticated via JWT token obtained during login.
- Files up to 1MB are supported; binary files are automatically base64-encoded.
- File deduplication uses MD5 hashing — unchanged files are not re-uploaded.

## Development

```bash
git clone https://github.com/squidcode/forever-plugin.git
cd forever-plugin
npm install
npm run build
```

### Scripts

| Script          | Description                  |
|-----------------|------------------------------|
| `npm run build` | Compile TypeScript           |
| `npm run dev`   | Watch mode                   |
| `npm run lint`  | Run ESLint                   |
| `npm run format`| Format with Prettier         |
| `npm run typecheck` | Type-check without emit  |

### Pre-commit Hooks

This project uses [Husky](https://typicode.github.io/husky/) + [lint-staged](https://github.com/lint-staged/lint-staged) to enforce code quality on every commit:

- ESLint auto-fix + Prettier formatting on staged `.ts` files
- Full TypeScript type-check

## License

MIT
