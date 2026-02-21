#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import { basename } from 'path';
import { createApiClient } from './client.js';
import { getOrCreateMachineId } from './machine.js';

const server = new McpServer({
  name: 'forever',
  version: '0.2.0',
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
