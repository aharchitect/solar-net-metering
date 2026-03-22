# solar-net-metering
This repository offers a solar net metering program for Node-Red in conjunction with Home Assistant.

## Function Node Sources
The Node-RED `function` nodes are maintained as standalone JavaScript files and synced back into the flow export.

- Source manifest: [function-nodes/manifest.json](/home/andreas/git/solar-net-metering/function-nodes/manifest.json)
- Sync script: [scripts/sync-function-nodes.js](/home/andreas/git/solar-net-metering/scripts/sync-function-nodes.js)

Useful commands:

```bash
node scripts/sync-function-nodes.js extract
node scripts/sync-function-nodes.js build
node scripts/sync-function-nodes.js validate
```

`extract` writes the current function node code from `ControlFeedInFlow.json` into the mapped `.js` files.
`build` reads the mapped `.js` files and writes them back into `ControlFeedInFlow.json`.
