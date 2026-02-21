# @squidcode/forever-plugin

MCP (Model Context Protocol) plugin for [Forever](https://forever.squidcode.com) — a centralized persistent memory layer for Claude Code instances.

Forever lets multiple Claude Code sessions share memory across machines, projects, and time. This plugin connects Claude Code to your Forever server via MCP.

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- A Forever account ([register here](https://forever.squidcode.com/register))

## Setup

### 1. Authenticate

```bash
npx @squidcode/forever-plugin login
```

You'll be prompted for:
- **Server URL**: `https://forever.squidcode.com`
- **Email**: your registered email
- **Password**: your password

Credentials are saved to `~/.forever/credentials.json` (mode 0600).

### 2. Add to Claude Code

```bash
claude mcp add forever -- npx @squidcode/forever-plugin
```

This registers the plugin as an MCP server that Claude Code will start automatically.

## Tools

The plugin exposes three MCP tools:

### `memory_log`

Log an entry to Forever memory.

| Parameter   | Type     | Required | Description                          |
|-------------|----------|----------|--------------------------------------|
| `project`   | string   | yes      | Project name or git remote URL       |
| `type`      | enum     | yes      | `summary`, `decision`, or `error`    |
| `content`   | string   | yes      | The content to log                   |
| `tags`      | string[] | no       | Tags for categorization              |
| `sessionId` | string   | no       | Session ID for grouping entries      |

### `memory_get_recent`

Get recent memory entries for a project.

| Parameter | Type   | Required | Description                    |
|-----------|--------|----------|--------------------------------|
| `project` | string | yes      | Project name or git remote URL |
| `limit`   | number | no       | Number of entries (default 20) |

### `memory_search`

Search memory entries across projects.

| Parameter | Type   | Required | Description            |
|-----------|--------|----------|------------------------|
| `query`   | string | yes      | Search query           |
| `project` | string | no       | Filter by project      |
| `type`    | enum   | no       | Filter by entry type   |
| `limit`   | number | no       | Max results (default 20) |

## How It Works

- The plugin runs as an MCP stdio server, started by Claude Code on demand.
- Each machine gets a unique ID (stored in `~/.forever/machine.json`) for tracking which machine produced each memory entry.
- All API calls are authenticated via JWT token obtained during login.

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
