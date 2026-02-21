import { createHash } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export function computeMd5(buffer: Buffer): string {
  return createHash('md5').update(buffer).digest('hex');
}

export function isBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8192);
  return sample.includes(0);
}

export function readAndEncodeFile(filePath: string): {
  content: string;
  hash: string;
  size: number;
} {
  const buffer = readFileSync(filePath);
  if (buffer.length > 1_048_576) {
    throw new Error(`File exceeds 1MB limit (${buffer.length} bytes)`);
  }
  const hash = computeMd5(buffer);
  const content = isBinary(buffer)
    ? `base64:${buffer.toString('base64')}`
    : buffer.toString('utf-8');
  return { content, hash, size: buffer.length };
}

export function writeDecodedFile(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  if (content.startsWith('base64:')) {
    const data = Buffer.from(content.slice(7), 'base64');
    writeFileSync(filePath, data);
  } else {
    writeFileSync(filePath, content, 'utf-8');
  }
}
