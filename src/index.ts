#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import { basename } from 'path';
import { createApiClient } from './client.js';
import { getOrCreateMachineId } from './machine.js';
import { readAndEncodeFile, writeDecodedFile, computeMd5 } from './files.js';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const server = new McpServer({
  name: 'forever',
  version: '0.4.0',
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

// Login subcommand
if (process.argv[2] === 'login') {
  const readline = await import('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, resolve));

  console.log('Forever Plugin Login\n');

  const DEFAULT_SERVER = 'https://forever.squidcode.com';
  const serverUrlInput = await ask(`Server URL [${DEFAULT_SERVER}]: `);
  const serverUrl = serverUrlInput.trim() || DEFAULT_SERVER;
  const email = await ask('Email: ');
  const password = await ask('Password: ');

  try {
    const { default: axios } = await import('axios');
    const res = await axios.post(
      `${serverUrl.replace(/\/$/, '')}/api/auth/login`,
      {
        email,
        password,
      },
    );

    const { saveCredentials } = await import('./client.js');
    saveCredentials({ serverUrl, token: res.data.access_token });
    console.log(
      '\nAuthenticated! Credentials saved to ~/.forever/credentials.json',
    );
  } catch (err: any) {
    console.error(
      '\nLogin failed:',
      err.response?.data?.message || err.message,
    );
    process.exit(1);
  }

  rl.close();
  process.exit(0);
}

// Start MCP server
const transport = new StdioServerTransport();
await server.connect(transport);
