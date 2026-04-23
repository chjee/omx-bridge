import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Computes the X-Callback-Signature header value for a job callback.
 * body may be a string (sender side) or Buffer (receiver/raw-body side).
 * Never pass a re-serialized parsed JSON — key order may differ and will
 * break verification.
 */
export function computeCallbackSignature(jobId: string, body: string | Buffer, secret: string): string {
  const hmac = createHmac('sha256', secret);
  hmac.update(`${jobId}:`);
  hmac.update(body);
  return `sha256=${hmac.digest('hex')}`;
}

export function verifyCallbackSignature(
  jobId: string,
  rawBody: Buffer,
  secret: string,
  provided: string,
): boolean {
  if (!provided.startsWith('sha256=')) return false;
  const expected = computeCallbackSignature(jobId, rawBody, secret);
  try {
    return timingSafeEqual(
      Buffer.from(expected.slice('sha256='.length), 'hex'),
      Buffer.from(provided.slice('sha256='.length), 'hex'),
    );
  } catch {
    return false;
  }
}
