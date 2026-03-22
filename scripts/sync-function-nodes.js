const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const flowPath = path.join(repoRoot, "ControlFeedInFlow.json");
const manifestPath = path.join(repoRoot, "function-nodes", "manifest.json");

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function normalizeFunctionSource(source) {
    return source.replace(/\r\n/g, "\n").replace(/\n$/, "");
}

function loadManifest() {
    const manifest = readJson(manifestPath);
    const byId = new Map();

    for (const entry of manifest) {
        if (!entry.id || !entry.path) {
            throw new Error(`Invalid manifest entry: ${JSON.stringify(entry)}`);
        }
        if (byId.has(entry.id)) {
            throw new Error(`Duplicate manifest id: ${entry.id}`);
        }
        byId.set(entry.id, entry);
    }

    return byId;
}

function loadFlow() {
    return readJson(flowPath);
}

function getFunctionNodes(flow) {
    return flow.filter((node) => node.type === "function");
}

function extract() {
    const manifest = loadManifest();
    const flow = loadFlow();

    for (const node of getFunctionNodes(flow)) {
        const entry = manifest.get(node.id);
        if (!entry) {
            throw new Error(`Missing manifest entry for function node ${node.id} (${node.name})`);
        }
        if (entry.skipExtract) {
            console.log(`skip  ${entry.path}`);
            continue;
        }

        const targetPath = path.join(repoRoot, entry.path);
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, `${normalizeFunctionSource(node.func || "")}\n`);
        console.log(`write ${entry.path}`);
    }
}

function build() {
    const manifest = loadManifest();
    const flow = loadFlow();

    for (const node of getFunctionNodes(flow)) {
        const entry = manifest.get(node.id);
        if (!entry) {
            throw new Error(`Missing manifest entry for function node ${node.id} (${node.name})`);
        }

        const sourcePath = path.join(repoRoot, entry.path);
        if (!fs.existsSync(sourcePath)) {
            throw new Error(`Missing source file for ${node.id}: ${entry.path}`);
        }

        node.func = normalizeFunctionSource(fs.readFileSync(sourcePath, "utf8"));
        console.log(`sync  ${entry.path} -> ${node.name}`);
    }

    fs.writeFileSync(flowPath, `${JSON.stringify(flow, null, 4)}\n`);
    console.log(`saved ${path.relative(repoRoot, flowPath)}`);
}

function validate() {
    const manifest = loadManifest();
    const flow = loadFlow();
    const functionNodes = getFunctionNodes(flow);

    for (const node of functionNodes) {
        if (!manifest.has(node.id)) {
            throw new Error(`Missing manifest entry for function node ${node.id} (${node.name})`);
        }
    }

    for (const entry of manifest.values()) {
        if (!functionNodes.find((node) => node.id === entry.id)) {
            throw new Error(`Manifest entry does not exist in flow: ${entry.id} (${entry.path})`);
        }
    }

    console.log(`validated ${functionNodes.length} function nodes`);
}

function check() {
    const manifest = loadManifest();
    const flow = loadFlow();
    let mismatches = 0;

    for (const node of getFunctionNodes(flow)) {
        const entry = manifest.get(node.id);
        if (!entry) {
            throw new Error(`Missing manifest entry for function node ${node.id} (${node.name})`);
        }

        const sourcePath = path.join(repoRoot, entry.path);
        if (!fs.existsSync(sourcePath)) {
            throw new Error(`Missing source file for ${node.id}: ${entry.path}`);
        }

        const source = normalizeFunctionSource(fs.readFileSync(sourcePath, "utf8"));
        const current = normalizeFunctionSource(node.func || "");

        if (source !== current) {
            mismatches += 1;
            console.error(`mismatch ${entry.path} <-> ${node.name}`);
        }
    }

    if (mismatches > 0) {
        throw new Error(
            `Found ${mismatches} out-of-sync function nodes. Run: npm run functions:build`
        );
    }

    console.log("flow export is in sync with function-node sources");
}

const command = process.argv[2];

if (command === "extract") {
    extract();
} else if (command === "build") {
    build();
} else if (command === "validate") {
    validate();
} else if (command === "check") {
    check();
} else {
    console.error("Usage: node scripts/sync-function-nodes.js <extract|build|validate|check>");
    process.exit(1);
}
