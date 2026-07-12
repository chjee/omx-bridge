import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CwdBoundaryError,
  resolveAllowedExecutionCwd,
} from '../../src/jobs/cwd-boundary';

describe('resolveAllowedExecutionCwd', () => {
  it('returns the canonical path for a directory inside an allowed prefix', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cwd-boundary-'));
    const project = path.join(root, 'nested', 'project');
    await fs.mkdir(project, { recursive: true });

    await expect(resolveAllowedExecutionCwd(project, [root])).resolves.toBe(
      await fs.realpath(project),
    );
  });

  it('rejects traversal and sibling-prefix paths', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cwd-boundary-'));
    const allowed = path.join(root, 'work');
    const sibling = path.join(root, 'workspace');
    await fs.mkdir(allowed);
    await fs.mkdir(sibling);

    await expect(
      resolveAllowedExecutionCwd(path.join(allowed, '..', 'workspace'), [allowed]),
    ).rejects.toThrow(CwdBoundaryError);
    await expect(resolveAllowedExecutionCwd(sibling, [allowed])).rejects.toThrow(
      CwdBoundaryError,
    );
  });

  it('rejects missing directories', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cwd-boundary-'));

    await expect(
      resolveAllowedExecutionCwd(path.join(root, 'missing'), [root]),
    ).rejects.toThrow('cwd is not accessible');
  });

  it('rejects symlinks that escape the allowed prefix', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cwd-boundary-'));
    const allowed = path.join(root, 'allowed');
    const outside = path.join(root, 'outside');
    const link = path.join(allowed, 'escape');
    await fs.mkdir(allowed);
    await fs.mkdir(outside);
    await fs.symlink(outside, link, 'dir');

    await expect(resolveAllowedExecutionCwd(link, [allowed])).rejects.toThrow(
      CwdBoundaryError,
    );
  });
});
