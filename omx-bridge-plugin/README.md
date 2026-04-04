# omx-bridge-plugin

OpenClaw plugin that exposes the local `omx-bridge` NestJS service as agent tools.

## What it registers

- `omx_submit_job`
- `omx_get_job`
- `omx_list_jobs`
- `omx_cancel_job`

## Files

- `package.json` declares the plugin pack and `openclaw.extensions`
- `openclaw.plugin.json` provides the native OpenClaw manifest and config schema
- `index.ts` registers the tools with `definePluginEntry`

## Install

1. Place this directory somewhere OpenClaw can load, or add it to `plugins.load.paths`.
2. Install dependencies inside the plugin directory:

```bash
npm install
```

3. Enable the plugin in your OpenClaw config:

```json
{
  "plugins": {
    "load": {
      "paths": [
        "/path/to/omx-bridge/omx-bridge-plugin"
      ]
    },
    "entries": {
      "omx-bridge-plugin": {
        "enabled": true,
        "config": {
          "bridgeUrl": "http://localhost:3000"
        }
      }
    }
  }
}
```

4. Restart OpenClaw, then confirm the plugin is visible:

```bash
openclaw plugins list
openclaw plugins info omx-bridge-plugin
```

## Tool access

If your OpenClaw tool policy uses allowlists, allow either the whole plugin id or the specific tool names:

```json5
{
  agents: {
    list: [
      {
        id: "main",
        tools: {
          allow: [
            "omx-bridge-plugin",
            "omx_submit_job",
            "omx_get_job",
            "omx_list_jobs",
            "omx_cancel_job"
          ]
        }
      }
    ]
  }
}
```

## Configuration

The plugin accepts one config field:

- `bridgeUrl`: Base URL for the bridge service. Default: `http://localhost:3000`

## Bridge API mapping

- `omx_submit_job` -> `POST /jobs`
- `omx_get_job` -> `GET /jobs/:id`
- `omx_list_jobs` -> `GET /jobs?status=...`
- `omx_cancel_job` -> `POST /jobs/:id/cancel`

## Notes

- OpenClaw can load TypeScript extension entries directly from `openclaw.extensions`.
- The plugin also ships `openclaw.plugin.json`, which current native plugin discovery uses for config validation.
