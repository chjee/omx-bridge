import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BRIDGE_CONFIG, buildBridgeConfig } from '../config/bridge-config';
import { JobsController } from './jobs.controller';
import { JobQueueRepository } from './job-queue.repository';
import { JobRunnerService } from './job-runner.service';
import { JobsService } from './jobs.service';
import { defaultSpawn, OMX_SPAWN, OmxExecService } from './omx-exec.service';
import { ApiTokenGuard } from './api-token.guard';
import { CallbackAuthGuard } from './callback-auth.guard';
import { JobNotifyService } from './job-notify.service';
import { BridgeInstanceLockService } from './bridge-instance-lock.service';
import {
  defaultTmuxSpawn,
  TMUX_SPAWN,
  TmuxSessionRunnerService,
} from './tmux-session-runner.service';

@Module({
  controllers: [JobsController],
  providers: [
    {
      provide: BRIDGE_CONFIG,
      useFactory: (configService: ConfigService) => buildBridgeConfig(configService),
      inject: [ConfigService],
    },
    {
      provide: OMX_SPAWN,
      useValue: defaultSpawn,
    },
    {
      provide: TMUX_SPAWN,
      useValue: defaultTmuxSpawn,
    },
    JobQueueRepository,
    JobsService,
    OmxExecService,
    TmuxSessionRunnerService,
    JobRunnerService,
    BridgeInstanceLockService,
    ApiTokenGuard,
    CallbackAuthGuard,
    JobNotifyService,
  ],
})
export class JobsModule {}
