import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Callback signature protocol — SOURCE OF TRUTH.
 *
 * Three implementations exist and MUST stay byte-for-byte equivalent.
 * If you change the algorithm or message format here, also update:
 *   - omx-dispatch/index.ts        (buildCallbackSignatureHeader, verifyWebhookSignature)
 *   - omx-bridge-plugin/index.ts   (buildCallbackSignatureHeader)
 * and the protocol vectors in test/unit/callback-signature.spec.ts.
 *
 * Protocol contract:
 *   header  = X-Callback-Signature
 *   value   = "sha256=" + hex(HMAC_SHA256(secret, jobId + ":" + body))
 *   body    = the exact request body bytes (the receiver MUST verify against
 *             the raw bytes — re-serializing parsed JSON may reorder keys
 *             and produce a different HMAC).
 */

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
