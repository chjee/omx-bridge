'use strict';

const fs = require('node:fs');
const path = require('node:path');
const common = require('@nestjs/common');

const CONFIG_MODULE_OPTIONS = Symbol('CONFIG_MODULE_OPTIONS');

function stripWrappingQuotes(value) {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function parseEnvFile(content) {
  const parsed = {};

  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const exportPrefix = 'export ';
    const normalized = line.startsWith(exportPrefix)
      ? line.slice(exportPrefix.length)
      : line;
    const separatorIndex = normalized.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = normalized.slice(0, separatorIndex).trim();
    const value = normalized.slice(separatorIndex + 1).trim();
    parsed[key] = stripWrappingQuotes(value);
  }

  return parsed;
}

function loadEnvFile(envFilePath) {
  const resolvedPath = path.resolve(process.cwd(), envFilePath);
  if (!fs.existsSync(resolvedPath)) {
    return;
  }

  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(resolvedPath);
    return;
  }

  const parsed = parseEnvFile(fs.readFileSync(resolvedPath, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

class ConfigService {
  get(propertyPath, defaultValue) {
    const value = process.env[propertyPath];
    if (value === undefined) {
      return defaultValue;
    }

    if (typeof defaultValue === 'number') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : defaultValue;
    }

    if (typeof defaultValue === 'boolean') {
      return value === 'true';
    }

    return value;
  }
}

common.Injectable()(ConfigService);

class ConfigModule {}

ConfigModule.forRoot = function forRoot(options = {}) {
  loadEnvFile(options.envFilePath || '.env');

  return {
    module: ConfigModule,
    global: Boolean(options.isGlobal),
    providers: [
      { provide: CONFIG_MODULE_OPTIONS, useValue: options },
      ConfigService,
    ],
    exports: [ConfigService],
  };
};

module.exports = {
  ConfigModule,
  ConfigService,
};
