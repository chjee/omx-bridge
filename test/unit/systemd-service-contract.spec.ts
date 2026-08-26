import fs from 'node:fs';
import path from 'node:path';

describe('omx-bridge systemd service containment contract', () => {
  const serviceFile = fs.readFileSync(
    path.resolve(__dirname, '../../omx-bridge.service'),
    'utf8',
  );
  const serviceSection = serviceFile.split(/^\[Service\]\s*$/m)[1]?.split(/^\[/m)[0];

  it('contains a Service section', () => {
    expect(serviceSection).toBeDefined();
  });

  it.each([
    ['KillMode', 'control-group'],
    ['TimeoutStopSec', '30s'],
    ['SendSIGKILL', 'yes'],
  ])('sets %s=%s exactly once', (directive, value) => {
    const matches = serviceSection?.match(new RegExp(`^${directive}=(.+)$`, 'gm')) ?? [];

    expect(matches).toEqual([`${directive}=${value}`]);
  });
});
