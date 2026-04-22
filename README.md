# LinkMind Context Engine Plugin for OpenClaw

`linkmind-context` is a native OpenClaw plugin that registers a custom context engine via `api.registerContextEngine(id, factory)`. It compacts long conversation history by sending the current session messages to the LinkMind API and can be selected through `plugins.slots.contextEngine`.

Repository: [landingbj/linkmind-context](https://github.com/landingbj/linkmind-context)

## Features

- Registers a native OpenClaw context engine named `linkmind-context`
- Triggers compaction when the accumulated context exceeds a configurable threshold
- Calls `POST /openclaw/compress` on the LinkMind service
- Supports optional bearer-token authentication
- Keeps the plugin configuration validated through `openclaw.plugin.json`

## Project Layout

```text
linkmind-context/
|- src/
|  |- index.ts
|  `- types.ts
|- openclaw.plugin.json
|- package.json
|- tsconfig.json
`- README.md
```

## Requirements

- Node.js 22 or newer
- OpenClaw with plugin support enabled
- A reachable LinkMind service endpoint

## Install for Local Development

```bash
npm install
npm run build
openclaw plugins install -l .
```

After installing, restart the OpenClaw gateway so the plugin can be discovered and loaded.

## Install from a Published Package

Once the package is published, users can install it with:

```bash
openclaw plugins install linkmind-context@latest
```

OpenClaw checks ClawHub first and falls back to npm automatically.

## OpenClaw Configuration

Configure the plugin in your OpenClaw config file and select it as the active context engine:

```json
{
  "plugins": {
    "slots": {
      "contextEngine": "linkmind-context"
    },
    "entries": {
      "linkmind-context": {
        "enabled": true,
        "config": {
          "apiUrl": "http://localhost:8080/v1",
          "logLevel": "info"
        }
      }
    }
  }
}
```

## Configuration Reference

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `apiUrl` | `string` | `http://localhost:8080/v1` | Base URL of the LinkMind service |
| `logLevel` | `string` | `info` | Log Level |


## Publish Checklist

- `package.json` includes `openclaw.extensions`
- `openclaw.plugin.json` exists at the package root
- The published tarball includes `dist/`, `README.md`, and `openclaw.plugin.json`
- Source code is hosted publicly on GitHub
- This README documents installation and configuration

## Development Notes

- Build output is emitted to `dist/`
- `npm pack` and `npm publish` will run `npm run build` first through `prepack`
- For a production release, publish the package, then submit it to the OpenClaw community plugin list with the package name, repository URL, description, and install command

## License

ISC
