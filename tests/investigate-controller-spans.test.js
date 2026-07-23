const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { runFunctionNode } = require("./helpers/run-function-node");

const controllerLogPath = path.join(__dirname, "..", "logFileMsg_ControllerDayHandling.csv");
const normalizationLogPath = path.join(
    __dirname,
    "..",
    "logFileMsg_NormalizeHomeAssistantData.csv"
);
const controllerScriptPath = path.join(
    __dirname,
    "..",
    "function-nodes",
    "ControllerDayHandling.js"
);

function readRows(csvPath) {
    const [header, ...lines] = fs.readFileSync(csvPath, "utf8").trim().split(/\r?\n/);
    const columns = header.split(";");

    return lines.map((line) => {
        const fields = line.split(";");
        return Object.fromEntries(columns.map((column, index) => [column, fields[index]]));
    });
}

function readControllerRows() {
    return readRows(controllerLogPath);
}

function rowsDuring(rows, start, end) {
    return rows.filter((row) => row.time >= start && row.time <= end);
}

function number(value) {
    return Number(value);
}

function executeLowConfidenceControllerRow(row, lastCommand) {
    const gridPower = number(row.gridPower);
    const liveSolarPower = number(row.liveSolarPower);
    const stableSolarPower = number(row.stableSolarPower);
    const calculatedDemand = number(row.calculatedDemand);
    const currentDemand = number(row.currentDemand);

    const execution = runFunctionNode(controllerScriptPath, {
        now: row.time,
        contextState: { lastCommand },
        msg: {
            data: {
                grid: { power: gridPower },
                solar: {
                    primaryPower: liveSolarPower,
                    secondaryPower: 0,
                    totalPower: number(row.totalProduced)
                },
                battery: {
                    chargePower: number(row.batteryInflow),
                    chargeSetpoint: number(row.currentSetInflow),
                    chargeHardwareMaxPower: number(row.maxChargePower),
                    soc: number(row.soc),
                    minSoc: number(row.minSoc)
                }
            },
            derived: {
                demand: {
                    defensiveTarget: calculatedDemand,
                    current: currentDemand,
                    median: number(row.medianDemand)
                },
                solar: {
                    livePower: liveSolarPower,
                    averagePower: stableSolarPower
                }
            },
            meta: {
                stability: { mode: row.mode },
                sensorTiming: {
                    thresholds: { reliableConfidence: 0.7 },
                    demand: {
                        confidence: number(row.demandConfidence),
                        currentEstimate: currentDemand,
                        sensors: { grid: { isValid: true } }
                    }
                },
                normalization: {
                    readings: {
                        gridPower: { isValid: true },
                        solarPrimaryPower: { isValid: true },
                        solarSecondaryPower: { isValid: true }
                    },
                    plausibility: { isConsistent: false }
                }
            }
        }
    });

    return execution.result[1].payload;
}

const rows = readControllerRows();
const normalizationRows = readRows(normalizationLogPath);

test("midday export window never commands the observed 0W alternation", () => {
    const samples = rowsDuring(rows, "2026-07-23T12:22:48.151Z", "2026-07-23T12:31:09.426Z");

    assert.equal(samples.length, 50);
    assert.equal(samples[0].finalCommand, "750");
    assert.equal(samples.at(-1).finalCommand, "1000");
    assert.equal(samples.filter((sample) => sample.finalCommand === "0").length, 0);
    assert.equal(samples.filter((sample) => sample.finalCommand === "1000").length, 49);
    assert.ok(samples.every((sample) => sample.controlMode === "Low-Confidence Grid Steering"));
});

test("afternoon transition window never commands the observed 0W alternation", () => {
    const samples = rowsDuring(rows, "2026-07-23T14:12:08.755Z", "2026-07-23T14:18:18.925Z");

    assert.equal(samples.length, 37);
    assert.equal(samples[0].finalCommand, "98");
    assert.equal(samples.at(-1).finalCommand, "1000");
    assert.equal(samples.filter((sample) => sample.finalCommand === "0").length, 0);
    assert.equal(samples.filter((sample) => sample.finalCommand === "1000").length, 25);
    assert.ok(samples.every((sample) => sample.controlMode === "Low-Confidence Grid Steering"));
});

test("controller logs show no actuator readback after 1000W requests in either window", () => {
    const samples = [
        ...rowsDuring(rows, "2026-07-23T12:22:48.151Z", "2026-07-23T12:31:09.426Z"),
        ...rowsDuring(rows, "2026-07-23T14:12:08.755Z", "2026-07-23T14:18:18.925Z")
    ];
    const maximumRequestsWithoutReadback = samples.filter(
        (sample) =>
            sample.finalCommand === "1000" &&
            sample.batteryInflow === "0" &&
            sample.currentSetInflow === "0"
    );

    assert.equal(maximumRequestsWithoutReadback.length, 74);
    assert.equal(
        maximumRequestsWithoutReadback.filter((sample) => sample.clampReason === "Battery Max")
            .length,
        71
    );
});

test("a real modest-export row stays latched at 1000W after a missing actuator readback", () => {
    const [row] = rows.filter((sample) => sample.time === "2026-07-23T14:16:38.861Z");

    const afterMaximumRequest = executeLowConfidenceControllerRow(row, 1000);
    const afterControllerRestart = executeLowConfidenceControllerRow(row, 0);

    assert.equal(row.gridPower, "-62.33");
    assert.equal(afterMaximumRequest.baseCommand, 1000);
    assert.equal(afterMaximumRequest.exportCorrection, 92.33);
    assert.equal(afterMaximumRequest.rawTargetCharge, 1092.33);
    assert.equal(afterMaximumRequest.finalCommand, 1000);
    assert.equal(afterMaximumRequest.clampReason, "Battery Max");

    assert.equal(afterControllerRestart.baseCommand, 0);
    assert.equal(afterControllerRestart.rawTargetCharge, 92.33);
    assert.equal(afterControllerRestart.finalCommand, 92);
    assert.equal(afterControllerRestart.clampReason, "None");
});

test("the 14:14 export row proves low-confidence steering ignores the solar-surplus target", () => {
    const [row] = rows.filter((sample) => sample.time === "2026-07-23T14:14:48.820Z");
    const controllerOutput = executeLowConfidenceControllerRow(row, 1000);

    assert.equal(row.gridPower, "-560.21");
    assert.equal(row.liveSolarPower, "1043");
    assert.equal(row.effectiveSolarPower, "698");
    assert.equal(row.calculatedDemand, "436");
    assert.equal(controllerOutput.theoreticalSurplus, 262);

    assert.equal(controllerOutput.baseCommand, 1000);
    assert.equal(controllerOutput.exportCorrection, 590.21);
    assert.equal(controllerOutput.rawTargetCharge, 1590.21);
    assert.equal(controllerOutput.targetCharge, 1590);
    assert.equal(controllerOutput.finalCommand, 1000);
    assert.equal(controllerOutput.clampReason, "Battery Max");
});

test("real sensor data makes both windows low-confidence through stale battery-power readings", () => {
    const windows = [
        ["2026-07-23T12:22:48.151Z", "2026-07-23T12:31:09.426Z", 51],
        ["2026-07-23T14:12:08.755Z", "2026-07-23T14:18:18.925Z", 38]
    ];

    for (const [start, end, expectedSamples] of windows) {
        const samples = rowsDuring(normalizationRows, start, end);

        assert.equal(samples.length, expectedSamples);
        assert.ok(samples.every((sample) => sample.demandPlausible === "false"));
        assert.ok(samples.every((sample) => sample.batteryChargeStale === "true"));
        assert.ok(samples.every((sample) => sample.batteryDischargeStale === "true"));
        assert.ok(
            samples.every((sample) => sample.demandPlausibilityIssues.includes("stale_inputs"))
        );
        assert.ok(
            samples.every((sample) => sample.demandPlausibilityIssues.includes("timing_spread"))
        );
    }
});
