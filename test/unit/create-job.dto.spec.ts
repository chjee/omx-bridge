import { validate } from 'class-validator';
import { CreateJobDto, MAX_PROMPT_LENGTH } from '../../src/jobs/dto/create-job.dto';

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

  it('preserves optional metadata fields', async () => {
    const dto = new CreateJobDto();
    dto.prompt = 'Implement phase 1';
    dto.requestId = 'req-1';
    dto.metadata = { source: 'openclaw', chatId: 1234 };

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.metadata).toEqual({ source: 'openclaw', chatId: 1234 });
  });
});
