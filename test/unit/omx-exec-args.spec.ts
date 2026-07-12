import { buildOmxExecArgs } from '../../src/jobs/omx-exec-args';

describe('buildOmxExecArgs', () => {
  it('keeps configured values as distinct argv entries', () => {
    const model = 'gpt custom; touch /tmp/not-executed';

    expect(buildOmxExecArgs({
      omxModel: model,
      omxModelReasoningEffort: 'xhigh',
    })).toEqual([
      'exec',
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
      '--full-auto',
      '-s',
      'danger-full-access',
      '-',
    ]);
  });
});
