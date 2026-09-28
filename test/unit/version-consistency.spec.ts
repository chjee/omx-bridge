import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createTempDir } from '../helpers';

interface VersionCheckOutput {
  stdout: { write: (value: string) => void };
  stderr: { write: (value: string) => void };
}

interface VersionCheckModule {
  main: (args: string[], output: VersionCheckOutput) => number;
}

interface PackageFixtureOptions {
  manifestVersion?: string;
}

async function writePackageFixture(
  root: string,
  relativeDirectory: string,
  name: string,
  version: string,
): Promise<void> {
  const directory = path.join(root, relativeDirectory);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, 'package.json'),
    `${JSON.stringify({ name, version }, null, 2)}\n`,
    'utf8',
  );
  await fs.writeFile(
    path.join(directory, 'package-lock.json'),
    `${JSON.stringify({
      name,
      version,
      lockfileVersion: 3,
      packages: { '': { name, version } },
    }, null, 2)}\n`,
    'utf8',
  );
}

async function createVersionFixture(options: PackageFixtureOptions = {}): Promise<string> {
  const root = await createTempDir('version-consistency');
  await writePackageFixture(root, '.', 'omx-bridge', '0.1.2');
  await writePackageFixture(root, 'omx-dispatch', 'omx-dispatch', '0.1.2');
  await writePackageFixture(root, 'omx-bridge-plugin', 'omx-bridge-plugin', '0.1.2');
  await fs.writeFile(
    path.join(root, 'omx-bridge-plugin', 'openclaw.plugin.json'),
    `${JSON.stringify({
      id: 'omx-bridge-plugin',
      version: options.manifestVersion ?? '0.1.2',
    }, null, 2)}\n`,
    'utf8',
  );
  return root;
}

function runVersionCheck(root: string) {
  const checker = require(path.resolve(
    process.cwd(),
    'scripts/version-consistency-check.cjs',
  )) as VersionCheckModule;
  let stdout = '';
  let stderr = '';
  const status = checker.main(['--root', root], {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
  });
  return { status, stdout, stderr };
}

describe('version consistency check', () => {
  it('accepts aligned package, lockfile, and OpenClaw manifest versions', async () => {
    const root = await createVersionFixture();

    try {
      const result = runVersionCheck(root);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('[version-consistency] passed (0.1.2)');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('exits non-zero when the OpenClaw manifest version drifts', async () => {
    const root = await createVersionFixture({ manifestVersion: '0.1.0' });

    try {
      const result = runVersionCheck(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('omx-bridge-plugin/openclaw.plugin.json version 0.1.0');
      expect(result.stderr).toContain('expected 0.1.2');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
