import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { JobCallbackDto } from '../../src/jobs/dto/job-callback.dto';

describe('JobCallbackDto', () => {
  it('accepts invalid_cwd execution error types', async () => {
    const dto = plainToInstance(JobCallbackDto, {
      status: 'failed',
      execution: {
        errorType: 'invalid_cwd',
      },
    });

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });

  it('rejects unknown execution error types', async () => {
    const dto = plainToInstance(JobCallbackDto, {
      status: 'failed',
      execution: {
        errorType: 'unknown_error',
      },
    });

    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'execution')).toBe(true);
  });
});
