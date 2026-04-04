import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BRIDGE_CONFIG, buildBridgeConfig } from '../config/bridge-config';
import { JobsController } from './jobs.controller';
import { JobQueueRepository } from './job-queue.repository';
import { JobRunnerService } from './job-runner.service';
import { JobsService } from './jobs.service';
import { defaultSpawn, OMX_SPAWN, OmxExecService } from './omx-exec.service';

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
    JobQueueRepository,
    JobsService,
    OmxExecService,
    JobRunnerService,
  ],
})
export class JobsModule {}
