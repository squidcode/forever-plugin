import { randomBytes } from 'crypto';
import { hostname } from 'os';
import { getMachineConfig, saveMachineConfig } from './client.js';

export function getOrCreateMachineId(): string {
  const config = getMachineConfig();
  if (config?.machineId) return config.machineId;

  const id = `${hostname()}-${randomBytes(4).toString('hex')}`;
  saveMachineConfig({ machineId: id, alias: hostname() });
  return id;
}
