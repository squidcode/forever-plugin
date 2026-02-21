import axios, { type AxiosInstance } from 'axios';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const CONFIG_DIR = join(homedir(), '.forever');
const CREDENTIALS_FILE = join(CONFIG_DIR, 'credentials.json');
const MACHINE_FILE = join(CONFIG_DIR, 'machine.json');

interface Credentials {
  serverUrl: string;
  token: string;
}

interface MachineConfig {
  machineId: string;
  alias: string;
}

function ensureConfigDir() {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

export function getCredentials(): Credentials | null {
  if (!existsSync(CREDENTIALS_FILE)) return null;
  try {
    return JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

export function saveCredentials(creds: Credentials) {
  ensureConfigDir();
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), {
    mode: 0o600,
  });
}

export function getMachineConfig(): MachineConfig | null {
  if (!existsSync(MACHINE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(MACHINE_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

export function saveMachineConfig(config: MachineConfig) {
  ensureConfigDir();
  writeFileSync(MACHINE_FILE, JSON.stringify(config, null, 2), {
    mode: 0o600,
  });
}

export function createApiClient(options?: {
  timeout?: number;
}): AxiosInstance | null {
  const creds = getCredentials();
  if (!creds) return null;

  return axios.create({
    baseURL: creds.serverUrl.replace(/\/$/, '') + '/api',
    headers: {
      Authorization: `Bearer ${creds.token}`,
      'Content-Type': 'application/json',
    },
    timeout: options?.timeout ?? 10000,
  });
}
