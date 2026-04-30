import fs from 'node:fs/promises';
import path from 'node:path';

export class CwdBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CwdBoundaryError';
  }
}

export async function resolveAllowedExecutionCwd(
  cwd: string | undefined,
  allowedPrefixes: readonly string[],
): Promise<string | undefined> {
  if (!cwd) {
    return undefined;
  }

  const resolvedCwd = path.resolve(cwd);
  const realCwd = await realpathOrThrow(resolvedCwd, cwd);
  const realPrefixes = await Promise.all(
    allowedPrefixes.map((prefix) => realpathIfAvailable(path.resolve(prefix))),
  );
  const allowed = realPrefixes.some((prefix) => isInsidePath(prefix, realCwd));

  if (!allowed) {
    throw new CwdBoundaryError(`cwd is outside allowed prefixes: ${cwd}`);
  }

  return realCwd;
}

async function realpathOrThrow(resolvedCwd: string, originalCwd: string): Promise<string> {
  try {
    return await fs.realpath(resolvedCwd);
  } catch (error) {
    throw new CwdBoundaryError(`cwd is not accessible: ${originalCwd} (${describeError(error)})`);
  }
}

async function realpathIfAvailable(resolvedPath: string): Promise<string> {
  try {
    return await fs.realpath(resolvedPath);
  } catch {
    return resolvedPath;
  }
}

function isInsidePath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
