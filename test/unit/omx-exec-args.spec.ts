import { buildOmxExecArgs } from '../../src/jobs/omx-exec-args';

describe('buildOmxExecArgs', () => {
  it('keeps configured values as distinct argv entries', () => {
    const model = 'gpt custom; touch /tmp/not-executed';

    expect(buildOmxExecArgs({
      omxModel: model,
      omxModelReasoningEffort: 'xhigh',
    })).toEqual([
      'exec',
      '--skip-git-repo-check',
      '-c',
      'approval_policy="never"',
      '-s',
      'danger-full-access',
      '--model',
      model,
      '-c',
      'model_reasoning_effort="xhigh"',
      '-',
    ]);
  });

  it('uses stdin for the prompt instead of placing prompt content in argv', () => {
    expect(buildOmxExecArgs({})).toEqual([
      'exec',
      '--skip-git-repo-check',
      '-c',
      'approval_policy="never"',
      '-s',
      'danger-full-access',
      '-',
    ]);
  });

  it('adds the fixed non-git cwd flag exactly once before the stdin marker', () => {
    const args = buildOmxExecArgs({});

    expect(args.filter((arg) => arg === '--skip-git-repo-check')).toHaveLength(1);
    expect(args.indexOf('--skip-git-repo-check')).toBe(args.indexOf('exec') + 1);
    expect(args.indexOf('--skip-git-repo-check')).toBeLessThan(args.indexOf('-'));
  });

  it('pins unattended approval separately from the sandbox contract', () => {
    const args = buildOmxExecArgs({});

    expect(args.filter((arg) => arg === 'approval_policy="never"')).toHaveLength(1);
    expect(args[args.indexOf('approval_policy="never"') - 1]).toBe('-c');
    expect(args.filter((arg) => arg === '--full-auto')).toHaveLength(0);
    expect(args.filter((arg) => arg === '--ask-for-approval')).toHaveLength(0);
    expect(args.filter((arg) => arg === '--dangerously-bypass-approvals-and-sandbox')).toHaveLength(0);
    expect(args.filter((arg) => arg === '--yolo')).toHaveLength(0);
    expect(args.slice(-3)).toEqual(['-s', 'danger-full-access', '-']);
  });

  it('keeps a model-only override after the fixed execution policy', () => {
    expect(buildOmxExecArgs({ omxModel: 'gpt-5.5' })).toEqual([
      'exec',
      '--skip-git-repo-check',
      '-c',
      'approval_policy="never"',
      '-s',
      'danger-full-access',
      '--model',
      'gpt-5.5',
      '-',
    ]);
  });

  it('keeps a reasoning-only override distinct from the approval config', () => {
    expect(buildOmxExecArgs({ omxModelReasoningEffort: 'high' })).toEqual([
      'exec',
      '--skip-git-repo-check',
      '-c',
      'approval_policy="never"',
      '-s',
      'danger-full-access',
      '-c',
      'model_reasoning_effort="high"',
      '-',
    ]);
  });
});
