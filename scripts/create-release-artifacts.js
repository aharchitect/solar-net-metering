const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const distRoot = path.join(repoRoot, "dist");
const releaseRoot = path.join(distRoot, "release");

const filesToCopy = [
    "ControlFeedInFlow.json",
    "README.md",
    "LICENSE"
];

const directoriesToCopy = [];

function cleanDir(targetPath) {
    fs.rmSync(targetPath, { recursive: true, force: true });
    fs.mkdirSync(targetPath, { recursive: true });
}

function copyEntry(relativePath) {
    const sourcePath = path.join(repoRoot, relativePath);
    const targetPath = path.join(releaseRoot, relativePath);

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.cpSync(sourcePath, targetPath, { recursive: true });
    console.log(`copy  ${relativePath}`);
}

cleanDir(releaseRoot);

for (const relativePath of filesToCopy) {
    copyEntry(relativePath);
}

for (const relativePath of directoriesToCopy) {
    copyEntry(relativePath);
}

console.log(`prepared release artifacts in ${path.relative(repoRoot, releaseRoot)}`);
