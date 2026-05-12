import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import {
  DEFAULT_REQUEST_BODY_LIMIT,
} from '../src/config/bridge-config';
import { computeCallbackSignature } from '../src/jobs/callback-signature';
import { JobNotifyService } from '../src/jobs/job-notify.service';
import { JobRunnerService } from '../src/jobs/job-runner.service';
import { createTempDir } from './helpers';

describe('Jobs HTTP auth and media type guards (e2e)', () => {
  let app: NestExpressApplication;

  async function createQueuedJob(prompt = 'callback target'): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/jobs')
      .set('Authorization', 'Bearer test-api-token')
      .send({ prompt })
      .expect(202);
    return response.body.jobId as string;
  }

  function signedCallbackBody(jobId: string): {
    bodyText: string;
    signature: string;
  } {
    const bodyText = JSON.stringify({
      status: 'succeeded',
      stdout: 'callback result',
      exitCode: 0,
    });
    return {
      bodyText,
      signature: computeCallbackSignature(jobId, bodyText, 'test-callback-secret'),
    };
  }

  beforeEach(async () => {
    process.env.BRIDGE_JOBS_DIR = await createTempDir('bridge-http-auth');
    process.env.BRIDGE_API_TOKEN = 'test-api-token';
    process.env.BRIDGE_CALLBACK_SECRET = 'test-callback-secret';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(JobRunnerService)
      .useValue({
        trigger: jest.fn(),
        cancel: jest.fn(),
        trackCompletionNotification: jest.fn(),
      })
      .overrideProvider(JobNotifyService)
      .useValue({ notifyJobComplete: jest.fn() })
      .compile();

    app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
      rawBody: true,
    });
    app.useBodyParser('json', { limit: DEFAULT_REQUEST_BODY_LIMIT });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    delete process.env.BRIDGE_JOBS_DIR;
    delete process.env.BRIDGE_API_TOKEN;
    delete process.env.BRIDGE_CALLBACK_SECRET;
  });

  it('rejects job creation without the bridge API token', async () => {
    await request(app.getHttpServer())
      .post('/jobs')
      .send({ prompt: 'blocked' })
      .expect(401);
  });

  it('accepts authenticated JSON job creation', async () => {
    await request(app.getHttpServer())
      .post('/jobs')
      .set('Authorization', 'Bearer test-api-token')
      .send({ prompt: 'accepted' })
      .expect(202);
  });

  it('rejects urlencoded job creation even when authenticated', async () => {
    await request(app.getHttpServer())
      .post('/jobs')
      .set('Authorization', 'Bearer test-api-token')
      .type('form')
      .send({ prompt: 'csrf shaped form' })
      .expect(415);
  });

  it('accepts signed JSON callbacks using the raw request body bytes', async () => {
    const jobId = await createQueuedJob();
    const { bodyText, signature } = signedCallbackBody(jobId);

    const response = await request(app.getHttpServer())
      .post(`/jobs/${jobId}/callback`)
      .set('Content-Type', 'application/json')
      .set('X-Callback-Signature', signature)
      .send(bodyText)
      .expect(201);

    expect(response.body).toMatchObject({
      id: jobId,
      status: 'succeeded',
      stdout: 'callback result',
      exitCode: 0,
    });
  });

  it('rejects JSON callbacks without a signature', async () => {
    const jobId = await createQueuedJob();
    const { bodyText } = signedCallbackBody(jobId);

    await request(app.getHttpServer())
      .post(`/jobs/${jobId}/callback`)
      .set('Content-Type', 'application/json')
      .send(bodyText)
      .expect(401);
  });

  it('rejects JSON callbacks with an invalid signature', async () => {
    const jobId = await createQueuedJob();
    const { bodyText } = signedCallbackBody(jobId);

    await request(app.getHttpServer())
      .post(`/jobs/${jobId}/callback`)
      .set('Content-Type', 'application/json')
      .set('X-Callback-Signature', 'sha256=bad')
      .send(bodyText)
      .expect(401);
  });

  it('rejects urlencoded callbacks before signature verification', async () => {
    const jobId = await createQueuedJob();
    const { bodyText, signature } = signedCallbackBody(jobId);

    await request(app.getHttpServer())
      .post(`/jobs/${jobId}/callback`)
      .set('X-Callback-Signature', signature)
      .type('form')
      .send({ payload: bodyText })
      .expect(415);
  });
});
