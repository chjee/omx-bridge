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
      '--full-auto',
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
      '--full-auto',
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
});
