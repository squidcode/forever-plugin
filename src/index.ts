#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import { basename, resolve, join } from 'path';
import { homedir } from 'os';
import { readFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { createApiClient } from './client.js';
import { getOrCreateMachineId } from './machine.js';
import { readAndEncodeFile, writeDecodedFile, computeMd5 } from './files.js';

const server = new McpServer({
  name: 'forever',
  version: '0.8.0',
});

const machineId = getOrCreateMachineId();
const sessionId = `${Date.now()}-${randomBytes(4).toString('hex')}`;

function git(...args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

function getGitContext() {
  return {
    gitBranch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    gitCommit: git('rev-parse', '--short', 'HEAD'),
    directory: process.cwd(),
  };
}

function resolveProject(explicit?: string): string | null {
  if (explicit) return explicit;
  const remote = git('remote', 'get-url', 'origin');
  if (remote) return remote;
  const dir = process.cwd();
  if (dir && dir !== '/') return basename(dir);
  return null;
}

server.tool(
  'memory_log',
  'Log an entry to Forever memory (summary, decision, or error)',
  {
    project: z
      .string()
      .optional()
      .describe(
        'Project name or git remote URL (auto-detected from git if omitted)',
      ),
    type: z
      .enum(['summary', 'decision', 'error'])
      .describe('Type of memory entry'),
    content: z.string().describe('The content to log'),
    tags: z
      .array(z.string())
      .optional()
      .describe('Optional tags for categorization'),
    sessionId: z
      .string()
      .optional()
      .describe('Session ID for grouping (auto-generated if omitted)'),
  },
  async ({ project, type, content, tags, sessionId: explicitSessionId }) => {
    const api = createApiClient();
    if (!api) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Not authenticated. Run: npx @squidcode/forever-plugin login',
          },
        ],
      };
    }

    const resolvedProject = resolveProject(project);
    if (!resolvedProject) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Could not detect project. Please specify a project name.',
          },
        ],
      };
    }

    const gitContext = getGitContext();

    try {
      await api.post('/logs', {
        project: resolvedProject,
        type,
        content,
        machineId,
        tags,
        sessionId: explicitSessionId || sessionId,
        ...gitContext,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: `Logged ${type} entry for "${resolvedProject}".`,
          },
        ],
      };
    } catch (err: any) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Failed to log: ${err.message}`,
          },
        ],
      };
    }
  },
);

server.tool(
  'memory_get_recent',
  'Get recent memory entries for a project',
  {
    project: z
      .string()
      .optional()
      .describe(
        'Project name or git remote URL (auto-detected from git if omitted)',
      ),
    limit: z
      .number()
      .optional()
      .default(20)
      .describe('Number of entries to fetch'),
  },
  async ({ project, limit }) => {
    const api = createApiClient();
    if (!api) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Not authenticated. Run: npx @squidcode/forever-plugin login',
          },
        ],
      };
    }

    const resolvedProject = resolveProject(project);
    if (!resolvedProject) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Could not detect project. Please specify a project name.',
          },
        ],
      };
    }

    try {
      const res = await api.get('/logs/recent', {
        params: { project: resolvedProject, limit },
      });
      const logs = res.data;
      if (!logs.length) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No memory entries found for project "${resolvedProject}".`,
            },
          ],
        };
      }

      const formatted = logs
        .map(
          (log: any) =>
            `[${log.type}] ${log.createdAt}\n${log.content}${log.tags?.length ? `\ntags: ${log.tags.join(', ')}` : ''}`,
        )
        .join('\n---\n');

      return { content: [{ type: 'text' as const, text: formatted }] };
    } catch (err: any) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Failed to fetch: ${err.message}`,
          },
        ],
      };
    }
  },
);

server.tool(
  'memory_get_sessions',
  'Get recent sessions for a project, grouped by session with machine info. Use at startup to detect cross-machine handoffs.',
  {
    project: z
      .string()
      .optional()
      .describe(
        'Project name or git remote URL (auto-detected from git if omitted)',
      ),
    limit: z
      .number()
      .optional()
      .default(10)
      .describe('Number of recent sessions to fetch'),
  },
  async ({ project, limit }) => {
    const api = createApiClient();
    if (!api) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Not authenticated. Run: npx @squidcode/forever-plugin login',
          },
        ],
      };
    }

    const resolvedProject = resolveProject(project);
    if (!resolvedProject) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Could not detect project. Please specify a project name.',
          },
        ],
      };
    }

    try {
      const res = await api.get('/logs/sessions', {
        params: { project: resolvedProject, machineId, limit },
      });
      const { sessions, hasRemoteActivity } = res.data;

      if (!sessions.length) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No previous sessions found for "${resolvedProject}".`,
            },
          ],
        };
      }

      const lines: string[] = [];

      if (hasRemoteActivity) {
        lines.push(
          '⚡ REMOTE ACTIVITY DETECTED — Sessions from other machines found for this project.\n',
        );
      }

      for (const s of sessions) {
        const machine = s.machineName || 'unknown';
        const remote = s.isRemote ? ' [REMOTE]' : ' [LOCAL]';
        const branch = s.gitBranch ? ` on ${s.gitBranch}` : '';
        const commit = s.gitCommit ? ` @ ${s.gitCommit}` : '';
        lines.push(`## Session ${s.sessionId}${remote}`);
        lines.push(`Machine: ${machine}${branch}${commit}`);
        lines.push(`Time: ${s.startedAt} → ${s.endedAt} (${s.logCount} logs)`);
        if (s.directory) lines.push(`Directory: ${s.directory}`);
        if (s.summary) lines.push(`Summary: ${s.summary}`);
        lines.push('');
      }

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (err: any) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Failed to fetch sessions: ${err.message}`,
          },
        ],
      };
    }
  },
);

server.tool(
  'memory_search',
  'Search memory entries across projects',
  {
    query: z.string().describe('Search query'),
    project: z.string().optional().describe('Filter by project'),
    type: z
      .enum(['user_input', 'claude_reply', 'summary', 'decision', 'error'])
      .optional()
      .describe('Filter by entry type'),
    limit: z.number().optional().default(20).describe('Max results'),
  },
  async ({ query, project, type, limit }) => {
    const api = createApiClient();
    if (!api) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Not authenticated. Run: npx @squidcode/forever-plugin login',
          },
        ],
      };
    }

    try {
      const params: Record<string, string | number> = { query, limit };
      if (project) params.project = project;
      if (type) params.type = type;

      const res = await api.get('/logs/search', { params });
      const logs = res.data;
      if (!logs.length) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No results for "${query}".`,
            },
          ],
        };
      }

      const formatted = logs
        .map(
          (log: any) =>
            `[${log.type}] ${log.project} - ${log.createdAt}\n${log.content}`,
        )
        .join('\n---\n');

      return { content: [{ type: 'text' as const, text: formatted }] };
    } catch (err: any) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Search failed: ${err.message}`,
          },
        ],
      };
    }
  },
);

// --- File Storage & Sharing Tools ---

function resolveFilePath(filePath: string): string {
  return resolve(process.cwd(), filePath);
}

server.tool(
  'memory_store_file',
  'Store a file in Forever for cross-machine access',
  {
    filePath: z
      .string()
      .describe('Path to the file to store (relative or absolute)'),
    project: z
      .string()
      .optional()
      .describe('Project name (auto-detected from git if omitted)'),
  },
  async ({ filePath, project }) => {
    const api = createApiClient({ timeout: 30000 });
    if (!api) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Not authenticated. Run: npx @squidcode/forever-plugin login',
          },
        ],
      };
    }

    const resolvedProject = resolveProject(project);
    if (!resolvedProject) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Could not detect project. Please specify a project name.',
          },
        ],
      };
    }

    const absPath = resolveFilePath(filePath);
    if (!existsSync(absPath)) {
      return {
        content: [
          { type: 'text' as const, text: `File not found: ${absPath}` },
        ],
      };
    }

    try {
      const { content, hash, size } = readAndEncodeFile(absPath);
      const res = await api.post('/files/store', {
        project: resolvedProject,
        filePath,
        content,
        contentHash: hash,
        machineId,
        sessionId,
      });

      const dedup = res.data.deduplicated ? ' (unchanged, skipped)' : '';
      return {
        content: [
          {
            type: 'text' as const,
            text: `Stored "${filePath}" (${size} bytes)${dedup}`,
          },
        ],
      };
    } catch (err: any) {
      const msg = err.response?.data?.message || err.message;
      return {
        content: [
          { type: 'text' as const, text: `Failed to store file: ${msg}` },
        ],
      };
    }
  },
);

server.tool(
  'memory_restore_file',
  'Restore a file from Forever to the local disk',
  {
    filePath: z.string().describe('Path of the file to restore'),
    project: z
      .string()
      .optional()
      .describe('Project name (auto-detected from git if omitted)'),
  },
  async ({ filePath, project }) => {
    const api = createApiClient({ timeout: 30000 });
    if (!api) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Not authenticated. Run: npx @squidcode/forever-plugin login',
          },
        ],
      };
    }

    const resolvedProject = resolveProject(project);
    if (!resolvedProject) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Could not detect project. Please specify a project name.',
          },
        ],
      };
    }

    try {
      const res = await api.get('/files/latest', {
        params: { project: resolvedProject, filePath },
      });

      if (!res.data) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No stored version found for "${filePath}"`,
            },
          ],
        };
      }

      const absPath = resolveFilePath(filePath);
      writeDecodedFile(absPath, res.data.content);

      return {
        content: [
          {
            type: 'text' as const,
            text: `Restored "${filePath}" (hash: ${res.data.contentHash})`,
          },
        ],
      };
    } catch (err: any) {
      const msg = err.response?.data?.message || err.message;
      return {
        content: [
          { type: 'text' as const, text: `Failed to restore file: ${msg}` },
        ],
      };
    }
  },
);

server.tool(
  'memory_share_file',
  'Mark a file for auto-sync across machines (also stores it immediately)',
  {
    filePath: z.string().describe('Path to the file to share'),
    project: z
      .string()
      .optional()
      .describe('Project name (auto-detected from git if omitted)'),
  },
  async ({ filePath, project }) => {
    const api = createApiClient({ timeout: 30000 });
    if (!api) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Not authenticated. Run: npx @squidcode/forever-plugin login',
          },
        ],
      };
    }

    const resolvedProject = resolveProject(project);
    if (!resolvedProject) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Could not detect project. Please specify a project name.',
          },
        ],
      };
    }

    const absPath = resolveFilePath(filePath);
    if (!existsSync(absPath)) {
      return {
        content: [
          { type: 'text' as const, text: `File not found: ${absPath}` },
        ],
      };
    }

    try {
      // Store the file first
      const { content, hash, size } = readAndEncodeFile(absPath);
      await api.post('/files/store', {
        project: resolvedProject,
        filePath,
        content,
        contentHash: hash,
        machineId,
        sessionId,
      });

      // Mark as shared
      await api.post('/files/share', {
        project: resolvedProject,
        filePath,
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: `Shared "${filePath}" (${size} bytes) — will auto-sync across machines`,
          },
        ],
      };
    } catch (err: any) {
      const msg = err.response?.data?.message || err.message;
      return {
        content: [
          { type: 'text' as const, text: `Failed to share file: ${msg}` },
        ],
      };
    }
  },
);

server.tool(
  'memory_unshare_file',
  'Stop auto-syncing a file across machines',
  {
    filePath: z.string().describe('Path of the file to stop sharing'),
    project: z
      .string()
      .optional()
      .describe('Project name (auto-detected from git if omitted)'),
  },
  async ({ filePath, project }) => {
    const api = createApiClient();
    if (!api) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Not authenticated. Run: npx @squidcode/forever-plugin login',
          },
        ],
      };
    }

    const resolvedProject = resolveProject(project);
    if (!resolvedProject) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Could not detect project. Please specify a project name.',
          },
        ],
      };
    }

    try {
      await api.post('/files/unshare', {
        project: resolvedProject,
        filePath,
      });

      return {
        content: [
          { type: 'text' as const, text: `Stopped sharing "${filePath}"` },
        ],
      };
    } catch (err: any) {
      const msg = err.response?.data?.message || err.message;
      return {
        content: [
          { type: 'text' as const, text: `Failed to unshare file: ${msg}` },
        ],
      };
    }
  },
);

server.tool(
  'memory_sync_files',
  'Sync all shared files for a project — downloads newer versions, uploads local changes',
  {
    project: z
      .string()
      .optional()
      .describe('Project name (auto-detected from git if omitted)'),
  },
  async ({ project }) => {
    const api = createApiClient({ timeout: 30000 });
    if (!api) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Not authenticated. Run: npx @squidcode/forever-plugin login',
          },
        ],
      };
    }

    const resolvedProject = resolveProject(project);
    if (!resolvedProject) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Could not detect project. Please specify a project name.',
          },
        ],
      };
    }

    try {
      // Get list of shared files
      const sharedRes = await api.get('/files/shared', {
        params: { project: resolvedProject },
      });
      const sharedFiles: Array<{ filePath: string }> = sharedRes.data;

      if (!sharedFiles.length) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No shared files for "${resolvedProject}"`,
            },
          ],
        };
      }

      // Build local hash map
      const localFiles: Array<{
        filePath: string;
        contentHash: string;
        exists: boolean;
      }> = [];
      for (const sf of sharedFiles) {
        const absPath = resolveFilePath(sf.filePath);
        if (existsSync(absPath)) {
          const buffer = readFileSync(absPath);
          localFiles.push({
            filePath: sf.filePath,
            contentHash: computeMd5(buffer),
            exists: true,
          });
        } else {
          localFiles.push({
            filePath: sf.filePath,
            contentHash: '',
            exists: false,
          });
        }
      }

      // Check sync status
      const syncRes = await api.post('/files/sync', {
        project: resolvedProject,
        files: localFiles.map((f) => ({
          filePath: f.filePath,
          contentHash: f.contentHash,
        })),
      });

      const results: string[] = [];
      let downloaded = 0;
      let uploaded = 0;
      let upToDate = 0;

      for (const file of syncRes.data.files) {
        const local = localFiles.find((f) => f.filePath === file.filePath);

        if (
          file.status === 'download_needed' ||
          (file.status === 'upload_needed' && !local?.exists)
        ) {
          // Download from server
          const latestRes = await api.get('/files/latest', {
            params: { project: resolvedProject, filePath: file.filePath },
          });
          if (latestRes.data) {
            const absPath = resolveFilePath(file.filePath);
            writeDecodedFile(absPath, latestRes.data.content);
            results.push(`↓ ${file.filePath}`);
            downloaded++;
          }
        } else if (file.status === 'upload_needed' && local?.exists) {
          // Upload to server
          const { content, hash } = readAndEncodeFile(
            resolveFilePath(file.filePath),
          );
          await api.post('/files/store', {
            project: resolvedProject,
            filePath: file.filePath,
            content,
            contentHash: hash,
            machineId,
            sessionId,
          });
          results.push(`↑ ${file.filePath}`);
          uploaded++;
        } else {
          upToDate++;
        }
      }

      const summary = [`Synced ${sharedFiles.length} shared file(s):`];
      if (downloaded) summary.push(`  ${downloaded} downloaded`);
      if (uploaded) summary.push(`  ${uploaded} uploaded`);
      if (upToDate) summary.push(`  ${upToDate} up to date`);
      if (results.length) summary.push('', ...results);

      return {
        content: [{ type: 'text' as const, text: summary.join('\n') }],
      };
    } catch (err: any) {
      const msg = err.response?.data?.message || err.message;
      return {
        content: [{ type: 'text' as const, text: `Sync failed: ${msg}` }],
      };
    }
  },
);

// CLAUDE.md instructions injection
const FOREVER_MARKER = '## Forever Memory';
const FOREVER_INSTRUCTIONS = `
## Forever Memory

Use the Forever MCP tools to maintain persistent memory across sessions:

- At the start of sessions, use \`memory_get_recent\` to recall recent context for the current project
- At the end of each session, use \`memory_log\` with type "summary" to save what was accomplished
- Log important architectural or design decisions with type "decision"
- Log errors and their solutions with type "error"
- Use \`memory_search\` to find relevant past context when working on related problems
- Always include the project name (repo name or git remote URL) when logging

### File Storage & Sharing

- When user says "store <file>" or "remember <file>", use \`memory_store_file\`
- When user says "restore <file>", use \`memory_restore_file\`
- When user says "share <file>", use \`memory_share_file\` for auto-sync
- When user says "unshare <file>", use \`memory_unshare_file\`
- At session start, call \`memory_sync_files\` to sync shared files
- Files up to 1MB supported; binary files handled automatically
- Only changed files are uploaded (MD5 dedup)

### Cross-Machine Handoff

- **At startup**: Always call \`memory_get_sessions\` to check for recent sessions from other machines. If remote activity is detected, review those sessions to understand what was done elsewhere and continue seamlessly.
- **Manual handoff**: When the user asks to "pull from forever", "check other machines", or "what happened on my other machine", call \`memory_get_sessions\` and summarize remote sessions.
- **Periodic awareness**: Before starting a new major task, check \`memory_get_sessions\` for any new remote activity on the current project since the session began.
- **Session continuity**: When continuing work from another machine, acknowledge what was done there and pick up where it left off.
`;

function ensureClaudeMdInstructions(force = false): 'added' | 'exists' {
  const claudeDir = join(homedir(), '.claude');
  const claudeMdPath = join(claudeDir, 'CLAUDE.md');

  // Read existing file if present
  let existing = '';
  if (existsSync(claudeMdPath)) {
    existing = readFileSync(claudeMdPath, 'utf-8');
    if (!force && existing.includes(FOREVER_MARKER)) {
      return 'exists';
    }
  } else {
    if (!existsSync(claudeDir)) {
      mkdirSync(claudeDir, { recursive: true });
    }
  }

  // Append instructions
  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  appendFileSync(claudeMdPath, separator + FOREVER_INSTRUCTIONS);
  return 'added';
}

// Install subcommand — inject CLAUDE.md instructions
if (process.argv[2] === 'install') {
  const force = process.argv.includes('--force');
  const result = ensureClaudeMdInstructions(force);
  if (result === 'added') {
    console.log('Forever instructions added to ~/.claude/CLAUDE.md');
  } else {
    console.log(
      'Forever instructions already present in ~/.claude/CLAUDE.md (use --force to append anyway)',
    );
  }
  process.exit(0);
}

// Login subcommand
if (process.argv[2] === 'login') {
  const SERVER_URL = 'https://forever.squidcode.com';

  console.log('Forever Plugin Login\n');

  try {
    const { default: axios } = await import('axios');

    // Request a device code
    const codeRes = await axios.post(`${SERVER_URL}/api/auth/device/code`);
    const { device_code, user_code, expires_in } = codeRes.data;

    const authUrl = `${SERVER_URL}/auth/device?code=${user_code}`;

    console.log('Your verification code:\n');
    console.log(`  ${user_code}\n`);
    console.log(`Open this URL to authorize:\n  ${authUrl}\n`);

    // Try to open browser automatically
    try {
      const { execFileSync } = await import('child_process');
      const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
      execFileSync(cmd, [authUrl], { stdio: 'ignore' });
    } catch {
      // Browser open failed — user can open manually
    }

    console.log('Waiting for authorization...');

    const deadline = Date.now() + expires_in * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5000));

      try {
        const tokenRes = await axios.post(
          `${SERVER_URL}/api/auth/device/token`,
          { device_code },
        );

        const { saveCredentials } = await import('./client.js');
        saveCredentials({
          serverUrl: SERVER_URL,
          token: tokenRes.data.access_token,
        });
        console.log(
          '\nAuthenticated! Credentials saved to ~/.forever/credentials.json',
        );

        // Inject CLAUDE.md instructions if not already present
        if (ensureClaudeMdInstructions() === 'added') {
          console.log('Forever instructions added to ~/.claude/CLAUDE.md');
        }

        process.exit(0);
      } catch (err: any) {
        const msg = err.response?.data?.message;
        if (msg === 'authorization_pending') {
          continue;
        }
        if (msg === 'expired_token') {
          console.error('\nCode expired. Please run login again.');
          process.exit(1);
        }
        throw err;
      }
    }

    console.error('\nCode expired. Please run login again.');
    process.exit(1);
  } catch (err: any) {
    console.error(
      '\nLogin failed:',
      err.response?.data?.message || err.message,
    );
    process.exit(1);
  }
}

// Search subcommand — CLI-based memory search
if (process.argv[2] === 'search') {
  const args = process.argv.slice(3);

  // Parse flags
  let project: string | undefined;
  let type: string | undefined;
  let limit = 20;
  const queryParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project' && args[i + 1]) {
      project = args[++i];
    } else if (args[i] === '--type' && args[i + 1]) {
      type = args[++i];
    } else if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[++i], 10) || 20;
    } else {
      queryParts.push(args[i]);
    }
  }

  const query = queryParts.join(' ');
  if (!query) {
    console.error(
      `Usage: npx @squidcode/forever-plugin search <query> [options]

Options:
  --project <name>   Filter by project (auto-detected if omitted)
  --type <type>      Filter by type (summary, decision, error)
  --limit <n>        Max results (default 20)

Examples:
  npx @squidcode/forever-plugin search "postgres migration"
  npx @squidcode/forever-plugin search "auth" --type decision --limit 5`,
    );
    process.exit(1);
  }

  const api = createApiClient();
  if (!api) {
    console.error(
      'Not authenticated. Run: npx @squidcode/forever-plugin login',
    );
    process.exit(1);
  }

  try {
    const params: Record<string, string | number> = { query, limit };
    const resolvedProject = resolveProject(project);
    if (resolvedProject) params.project = resolvedProject;
    if (type) params.type = type;

    const res = await api.get('/logs/search', { params });
    const logs = res.data;

    if (!logs.length) {
      console.error(`No results for "${query}".`);
      process.exit(0);
    }

    for (const log of logs) {
      const tags = log.tags?.length ? ` [${log.tags.join(', ')}]` : '';
      console.log(`[${log.type}] ${log.project} - ${log.createdAt}${tags}`);
      console.log(log.content);
      console.log('---');
    }
    process.exit(0);
  } catch (err: any) {
    console.error(
      `Search failed: ${err.response?.data?.message || err.message}`,
    );
    process.exit(1);
  }
}

// Log subcommand — CLI-based memory logging
if (process.argv[2] === 'log') {
  const args = process.argv.slice(3);
  if (args.length === 0) {
    console.error(
      `Usage: npx @squidcode/forever-plugin log <data>

Examples:
  npx @squidcode/forever-plugin log "deployed v2.1 to production"
  npx @squidcode/forever-plugin log '{"type":"decision","content":"chose postgres","tags":["db"]}'`,
    );
    process.exit(1);
  }

  const data = args.join(' ');
  let type: 'summary' | 'decision' | 'error' = 'summary';
  let content = data;
  let tags: string[] | undefined;
  let project: string | undefined;
  let explicitSessionId: string | undefined;

  try {
    const parsed = JSON.parse(data);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.content === 'string'
    ) {
      content = parsed.content;
      if (
        parsed.type === 'summary' ||
        parsed.type === 'decision' ||
        parsed.type === 'error'
      ) {
        type = parsed.type;
      }
      if (Array.isArray(parsed.tags)) tags = parsed.tags;
      if (typeof parsed.project === 'string') project = parsed.project;
      if (typeof parsed.sessionId === 'string')
        explicitSessionId = parsed.sessionId;
    }
  } catch {
    // Not JSON — use raw string as content
  }

  const api = createApiClient();
  if (!api) {
    console.error(
      'Not authenticated. Run: npx @squidcode/forever-plugin login',
    );
    process.exit(1);
  }

  const resolvedProject = resolveProject(project);
  if (!resolvedProject) {
    console.error(
      'Could not detect project. Pass "project" in JSON or run from a git repo.',
    );
    process.exit(1);
  }

  const gitContext = getGitContext();

  try {
    await api.post('/logs', {
      project: resolvedProject,
      type,
      content,
      machineId,
      tags,
      sessionId: explicitSessionId || sessionId,
      ...gitContext,
    });
    console.error(`Logged ${type} entry for "${resolvedProject}".`);
    process.exit(0);
  } catch (err: any) {
    console.error(
      `Failed to log: ${err.response?.data?.message || err.message}`,
    );
    process.exit(1);
  }
}

// Help / unknown subcommand
if (process.argv[2] === 'help' || process.argv[2] === '--help') {
  console.log(`Forever Plugin v0.8.0 — Claude Memory System

Usage: npx @squidcode/forever-plugin <command>

Commands:
  login              Authenticate with Forever (device auth flow)
  install            Add Forever instructions to ~/.claude/CLAUDE.md
  install --force    Add instructions even if already present
  log <data>         Log a memory entry from the CLI
  search <query>     Search memory entries
  help               Show this help message

Without a command, starts the MCP server (used by Claude Code).

Log examples:
  npx @squidcode/forever-plugin log "deployed v2.1 to production"
  npx @squidcode/forever-plugin log '{"type":"decision","content":"chose postgres","tags":["db"]}'

Search examples:
  npx @squidcode/forever-plugin search "postgres migration"
  npx @squidcode/forever-plugin search "auth" --type decision --limit 5

Setup:
  1. npx @squidcode/forever-plugin login
  2. claude mcp add forever -- npx @squidcode/forever-plugin`);
  process.exit(0);
}

if (process.argv[2]) {
  console.error(`Unknown command: ${process.argv[2]}`);
  console.error('Run with "help" to see available commands.');
  process.exit(1);
}

// Start MCP server
const transport = new StdioServerTransport();
await server.connect(transport);
