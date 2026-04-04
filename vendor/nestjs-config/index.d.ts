import type { DynamicModule } from '@nestjs/common';

export interface ConfigModuleOptions {
  envFilePath?: string;
  isGlobal?: boolean;
}

export declare class ConfigService {
  get<T = string>(propertyPath: string): T | undefined;
  get<T>(propertyPath: string, defaultValue: T): T;
}

export declare class ConfigModule {
  static forRoot(options?: ConfigModuleOptions): DynamicModule;
}
