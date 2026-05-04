import { validate } from 'class-validator';
import {
  CreateJobDto,
  MAX_METADATA_BYTES,
  MAX_PROMPT_LENGTH,
} from '../../src/jobs/dto/create-job.dto';

describe('CreateJobDto', () => {
  it('rejects an empty prompt', async () => {
    const dto = new CreateJobDto();
    dto.prompt = '';

    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'prompt')).toBe(true);
  });

  it('rejects an overly long prompt', async () => {
    const dto = new CreateJobDto();
    dto.prompt = 'x'.repeat(MAX_PROMPT_LENGTH + 1);

    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'prompt')).toBe(true);
  });

  it('accepts a minimal valid payload', async () => {
    const dto = new CreateJobDto();
    dto.prompt = 'Implement phase 1';

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });

  it('accepts explicit exec and tmux execution modes', async () => {
    for (const executionMode of ['exec', 'tmux'] as const) {
      const dto = new CreateJobDto();
      dto.prompt = 'Implement phase 1';
      dto.executionMode = executionMode;

      const errors = await validate(dto);

      expect(errors).toHaveLength(0);
    }
  });

  it('rejects unknown execution modes', async () => {
    const dto = new CreateJobDto();
    dto.prompt = 'Implement phase 1';
    // @ts-expect-error intentionally validating runtime input
    dto.executionMode = 'screen';

    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'executionMode')).toBe(true);
  });

  it('preserves optional metadata fields', async () => {
    const dto = new CreateJobDto();
    dto.prompt = 'Implement phase 1';
    dto.requestId = 'req-1';
    dto.metadata = { source: 'openclaw', chatId: 1234 };

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.metadata).toEqual({ source: 'openclaw', chatId: 1234 });
  });

  it('rejects oversized metadata payloads', async () => {
    const dto = new CreateJobDto();
    dto.prompt = 'Implement phase 1';
    dto.metadata = { payload: 'x'.repeat(MAX_METADATA_BYTES) };

    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'metadata')).toBe(true);
  });

  it('accepts channel source with sourceName', async () => {
    const dto = new CreateJobDto();
    dto.prompt = 'Implement phase 1';
    dto.source = 'channel';
    dto.sourceName = 'claude-chopper';
    dto.originRoutingKey = 'telegram:group:-100123';

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });

  it('rejects unknown source values', async () => {
    const dto = new CreateJobDto();
    dto.prompt = 'Implement phase 1';
    // @ts-expect-error intentionally validating runtime input
    dto.source = 'chopper';

    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'source')).toBe(true);
  });

  it('accepts loopback notify URLs', async () => {
    const dto = new CreateJobDto();
    dto.prompt = 'Implement phase 1';
    dto.notifyUrl = 'http://127.0.0.1:3993/notify';

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });

  it('rejects malformed notify URLs', async () => {
    const dto = new CreateJobDto();
    dto.prompt = 'Implement phase 1';
    dto.notifyUrl = 'not-a-url';

    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'notifyUrl')).toBe(true);
  });

  it('rejects non-loopback notify URLs', async () => {
    const dto = new CreateJobDto();
    dto.prompt = 'Implement phase 1';
    dto.notifyUrl = 'https://example.com/notify';

    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'notifyUrl')).toBe(true);
  });
});
