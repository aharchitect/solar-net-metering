# solar-net-metering

This repository offers a solar net metering program for Node-Red in conjunction with Home Assistant.

## Function Node Sources

The Node-RED `function` nodes are maintained as standalone JavaScript files and synced back into the flow export.

- Source manifest: [function-nodes/manifest.json](/home/andreas/git/solar-net-metering/function-nodes/manifest.json)
- Sync script: [scripts/sync-function-nodes.js](/home/andreas/git/solar-net-metering/scripts/sync-function-nodes.js)

Useful commands:

```bash
npm install
node scripts/sync-function-nodes.js extract
node scripts/sync-function-nodes.js build
node scripts/sync-function-nodes.js validate
node scripts/sync-function-nodes.js check
npm run release:prepare
```

`extract` writes the current function node code from `ControlFeedInFlow.json` into the mapped `.js` files.
`build` reads the mapped `.js` files and writes them back into `ControlFeedInFlow.json`.
`check` fails if any extracted source file and the flow export are out of sync.

## Tooling

The project now includes a small Node.js toolchain for linting, formatting, and CI checks.

```bash
npm run lint
npm run lint:fix
npm run format
npm run format:check
npm run release:prepare
npm run check
```

## GitHub Actions

The workflow at [.github/workflows/ci-release.yml](/home/andreas/git/solar-net-metering/.github/workflows/ci-release.yml) runs:

1. `npm run lint`
2. `npm run format:check`
3. `npm run functions:build`
4. `npm run functions:check`
5. `npm run release:prepare`

On a published GitHub release, the workflow uploads these generated assets to the release:

- `solar-net-metering-flow.json`
- `solar-net-metering-release.zip`
