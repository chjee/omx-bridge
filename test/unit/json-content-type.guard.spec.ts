import { UnsupportedMediaTypeException, type ExecutionContext } from '@nestjs/common';
import { JsonContentTypeGuard } from '../../src/jobs/json-content-type.guard';

function createContext(contentType?: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        headers: contentType === undefined ? {} : { 'content-type': contentType },
      }),
    }),
  } as unknown as ExecutionContext;
}

describe('JsonContentTypeGuard', () => {
  const guard = new JsonContentTypeGuard();

  it.each([
    'application/json',
    'application/json; charset=utf-8',
    'application/problem+json',
  ])('accepts JSON media type %s', (contentType) => {
    expect(guard.canActivate(createContext(contentType))).toBe(true);
  });

  it.each([
    undefined,
    'application/x-www-form-urlencoded',
    'text/plain',
    ['application/json'],
  ])('rejects non-JSON content type %p', (contentType) => {
    expect(() => guard.canActivate(createContext(contentType))).toThrow(
      UnsupportedMediaTypeException,
    );
  });
});
