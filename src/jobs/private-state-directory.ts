import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
const JOB_ID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const JOB_ID_PATTERN = new RegExp(`^${JOB_ID_SOURCE}$`, 'i');
export const JOB_STATE_FILE_PATTERN = new RegExp(
  `^${JOB_ID_SOURCE}\\.json(?:\\.${JOB_ID_SOURCE}\\.tmp)?$`,
  'i',
);
export const QUARANTINE_FILE_PATTERN = new RegExp(
  '^[^/\\\\]+\\.(?:invalid|malformed)\\.' +
  '\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z\\.json$',
  'i',
);

export interface PrivateOwnedDirectoryOptions {
  requireDedicated?: boolean;
}

export async function ensurePrivateOwnedDirectory(
  directory: string,
  label: string,
  acceptsEntry: (entry: Dirent) => boolean,
  options: PrivateOwnedDirectoryOptions = {},
): Promise<void> {
  if (process.platform === 'win32') {
    await fs.mkdir(directory, { recursive: true });
    return;
  }

  await assertNoSymlinkComponents(directory, label);
  const existing = await lstatIfExists(directory);
  if (existing?.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link: ${directory}`);
  }
  if (existing && !existing.isDirectory()) {
    throw new Error(`${label} is not a directory: ${directory}`);
  }

  await fs.mkdir(directory, {
    recursive: true,
    mode: PRIVATE_DIRECTORY_MODE,
  });

  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a real directory: ${directory}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(`${label} is not owned by the current user: ${directory}`);
  }

  const entries = await fs.readdir(directory, { withFileTypes: true });
  const unrelated = entries.find((entry) => entry.isSymbolicLink() || !acceptsEntry(entry));
  if (unrelated) {
    if (options.requireDedicated) {
      throw new Error(`${label} contains unrelated entry ${unrelated.name}: ${directory}`);
    }
    return;
  }

  await fs.chmod(directory, PRIVATE_DIRECTORY_MODE);
}

export async function assertPrivateOwnedFile(filePath: string, label: string): Promise<void> {
  if (process.platform === 'win32') return;
  await assertNoSymlinkComponents(filePath, label);
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a real file: ${filePath}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(`${label} is not owned by the current user: ${filePath}`);
  }
}

export async function tightenPrivateOwnedFile(filePath: string, label: string): Promise<void> {
  await assertPrivateOwnedFile(filePath, label);
  if (process.platform === 'win32') return;
  await fs.chmod(filePath, PRIVATE_FILE_MODE);
}

async function assertNoSymlinkComponents(targetPath: string, label: string): Promise<void> {
  const absolutePath = path.resolve(targetPath);
  const root = path.parse(absolutePath).root;
  const parts = path.relative(root, absolutePath).split(path.sep).filter(Boolean);
  let currentPath = root;

  for (const part of parts) {
    currentPath = path.join(currentPath, part);
    const stat = await lstatIfExists(currentPath);
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} path must not contain a symbolic link: ${currentPath}`);
    }
  }
}

async function lstatIfExists(filePath: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
