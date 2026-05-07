import type { BridgeConfig } from '../config/bridge-config';

// Codex exec treats "-" as the prompt-from-stdin marker; OMX passes this through.
export const OMX_STDIN_PROMPT_ARG = '-';

export function buildOmxExecArgs(config: Pick<BridgeConfig, 'omxModel' | 'omxModelReasoningEffort'>): string[] {
  const args = ['exec', '--full-auto', '-s', 'danger-full-access'];

  if (config.omxModel) {
    args.push('--model', config.omxModel);
  }

  if (config.omxModelReasoningEffort) {
    args.push('-c', `model_reasoning_effort="${config.omxModelReasoningEffort}"`);
  }

  args.push(OMX_STDIN_PROMPT_ARG);
  return args;
}
