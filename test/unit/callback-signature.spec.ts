import { createHmac } from 'node:crypto';
import {
  computeCallbackSignature,
  verifyCallbackSignature,
} from '../../src/jobs/callback-signature';

/**
 * Protocol vectors — single source of truth for the X-Callback-Signature
 * format. Three implementations exist (see header comments in
 * src/jobs/callback-signature.ts, omx-dispatch/index.ts, and
 * omx-bridge-plugin/index.ts) and they MUST all reproduce these vectors.
 *
 * If you need to change the protocol, update the algorithm in all three
 * implementations together with these vectors in the same change.
 */
const PROTOCOL_VECTORS: Array<{
  name: string;
  jobId: string;
  body: string;
  secret: string;
  expected: string;
}> = [
  {
    name: 'simple ASCII body',
    jobId: '00000000-0000-4000-a000-000000000001',
    body: '{"status":"succeeded"}',
    secret: 'shared-secret',
    expected: `sha256=${createHmac('sha256', 'shared-secret')
      .update('00000000-0000-4000-a000-000000000001:{"status":"succeeded"}')
      .digest('hex')}`,
  },
  {
    name: 'unicode body bytes',
    jobId: 'job-한글-id',
    body: '{"msg":"완료 ✅"}',
    secret: 'unicode-secret-키',
    expected: `sha256=${createHmac('sha256', 'unicode-secret-키')
      .update('job-한글-id:{"msg":"완료 ✅"}')
      .digest('hex')}`,
  },
  {
    name: 'empty body',
    jobId: 'empty',
    body: '',
    secret: 'k',
    expected: `sha256=${createHmac('sha256', 'k').update('empty:').digest('hex')}`,
  },
];

describe('callback-signature protocol', () => {
  describe('computeCallbackSignature', () => {
    for (const vector of PROTOCOL_VECTORS) {
      it(`produces the canonical hex for ${vector.name}`, () => {
        const sig = computeCallbackSignature(vector.jobId, vector.body, vector.secret);
        expect(sig).toBe(vector.expected);
      });
    }

    it('treats string and Buffer bodies as equivalent', () => {
      const jobId = 'eq';
      const secret = 's';
      const body = '{"a":1}';
      const fromString = computeCallbackSignature(jobId, body, secret);
      const fromBuffer = computeCallbackSignature(jobId, Buffer.from(body, 'utf8'), secret);
      expect(fromString).toBe(fromBuffer);
    });

    it('binds the signature to jobId — different ids yield different signatures', () => {
      const a = computeCallbackSignature('id-a', 'body', 'secret');
      const b = computeCallbackSignature('id-b', 'body', 'secret');
      expect(a).not.toBe(b);
    });
  });

  describe('verifyCallbackSignature', () => {
    it('accepts a freshly computed signature', () => {
      const jobId = 'v1';
      const secret = 's';
      const body = Buffer.from('{"k":"v"}', 'utf8');
      const sig = computeCallbackSignature(jobId, body, secret);
      expect(verifyCallbackSignature(jobId, body, secret, sig)).toBe(true);
    });

    it('rejects signatures that lack the sha256= prefix', () => {
      const jobId = 'v2';
      const secret = 's';
      const body = Buffer.from('x', 'utf8');
      const sig = computeCallbackSignature(jobId, body, secret).slice('sha256='.length);
      expect(verifyCallbackSignature(jobId, body, secret, sig)).toBe(false);
    });

    it('rejects signatures of the wrong length without throwing', () => {
      const jobId = 'v3';
      const secret = 's';
      const body = Buffer.from('x', 'utf8');
      expect(verifyCallbackSignature(jobId, body, secret, 'sha256=deadbeef')).toBe(false);
    });

    it('rejects tampered bodies', () => {
      const jobId = 'v4';
      const secret = 's';
      const original = Buffer.from('{"a":1}', 'utf8');
      const tampered = Buffer.from('{"a":2}', 'utf8');
      const sig = computeCallbackSignature(jobId, original, secret);
      expect(verifyCallbackSignature(jobId, tampered, secret, sig)).toBe(false);
    });

    it('rejects signatures created with a different secret', () => {
      const jobId = 'v5';
      const body = Buffer.from('x', 'utf8');
      const sig = computeCallbackSignature(jobId, body, 'secret-a');
      expect(verifyCallbackSignature(jobId, body, 'secret-b', sig)).toBe(false);
    });
  });
});
