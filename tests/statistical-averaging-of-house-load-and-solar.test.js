const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { runFunctionNode } = require("./helpers/run-function-node");

const statsScriptPath = path.join(
    __dirname,
    "..",
    "function-nodes",
    "statistical-averaging-of-house-load-and-solar.js"
);

function secondsBefore(timestamp, seconds) {
    return new Date(Date.parse(timestamp) - seconds * 1000).toISOString();
}

function entity(state, lastUpdated) {
    return {
        state: String(state),
        last_updated: lastUpdated
    };
}

function createPayload({
    now,
    gridPower,
    solarPrimaryPower,
    solarSecondaryPower,
    batteryChargePower,
    batteryDischargePower = 0,
    batteryChargeSetpoint = 0,
    batteryDischargeSetpoint = 0,
    gridTimestamp = now,
    solarPrimaryTimestamp = now,
    solarSecondaryTimestamp = now,
    batteryChargeTimestamp = now,
    batteryDischargeTimestamp = now
}) {
    return {
        "sensor.smartmeter_keller_sml_watt_summe": entity(gridPower, gridTimestamp),
        "sensor.wechselrichter_ac_leistung": entity(solarPrimaryPower, solarPrimaryTimestamp),
        "sensor.hoymiles600_power": entity(solarSecondaryPower, solarSecondaryTimestamp),
        "sensor.solarflow_800_pro_grid_input_power": entity(
            batteryChargePower,
            batteryChargeTimestamp
        ),
        "sensor.solarflow_800_pro_output_home_power": entity(
            batteryDischargePower,
            batteryDischargeTimestamp
        ),
        "number.solarflow_800_pro_input_limit": entity(batteryChargeSetpoint, now),
        "number.solarflow_800_pro_output_limit": entity(batteryDischargeSetpoint, now)
    };
}

function executeStats({ payload, contextState, now, flowState, msg } = {}) {
    const execution = runFunctionNode(statsScriptPath, {
        now,
        contextState,
        flowState,
        msg: {
            payload,
            meta: {
                trigger: {
                    intervalSeconds: 10
                }
            },
            ...msg
        }
    });

    return {
        ...execution,
        outputMsg: execution.result
    };
}

function assertApprox(actual, expected, epsilon = 1e-9) {
    assert.ok(
        Math.abs(actual - expected) <= epsilon,
        `Expected ${actual} to be within ${epsilon} of ${expected}`
    );
}

test("uses live values directly when all sensor timestamps are aligned", () => {
    const now = "2026-04-06T13:30:21.142Z";
    const payload = createPayload({
        now,
        gridPower: -190.46,
        solarPrimaryPower: 815.9,
        solarSecondaryPower: 433.4,
        batteryChargePower: 799
    });

    const { outputMsg, contextState, statuses } = executeStats({ payload, now });

    assert.equal(outputMsg.derived.demand.raw, 260);
    assert.equal(outputMsg.derived.demand.current, 260);
    assert.equal(outputMsg.meta.sensorTiming.demand.confidence, 1);
    assert.equal(outputMsg.derived.solar.rawPower, 1249);
    assert.equal(outputMsg.derived.solar.livePower, 1249);
    assert.equal(outputMsg.meta.sensorTiming.solar.confidence, 1);
    assert.deepEqual(structuredClone(outputMsg.derived.demand), {
        current: 260,
        raw: 260,
        average: 260,
        median: 260,
        lowerBound: 260,
        longTermMinimum: 260,
        defensiveTarget: 240,
        stdDev: 0,
        trend: 0,
        trendDirection: "flat",
        trendChanges: 0
    });
    assert.deepEqual(structuredClone(outputMsg.derived.solar), {
        livePower: 1249,
        rawPower: 1249,
        averagePower: 1249,
        stdDev: 0,
        trend: 0,
        trendDirection: "flat",
        trendChanges: 0
    });
    assert.equal(outputMsg.meta.stability.mode, "stable_stable");
    assert.equal(outputMsg.meta.sensorTiming.demand.maxAgeMs, 0);
    assert.equal(outputMsg.meta.sensorTiming.demand.spreadMs, 0);
    assertApprox(contextState.lastReliableDemand, 259.8399999999999);
    assertApprox(contextState.lastReliableSolar, 1249.3);
    assert.deepEqual(statuses, [
        {
            fill: "blue",
            shape: "dot",
            text: "Solar: 1249W | Demand: 260W | sync 100%"
        }
    ]);
});

test("detects stale solar-primary timestamps from the April 6 sample rows and falls back to the last reliable demand", () => {
    const firstNow = "2026-04-06T13:30:21.142Z";
    const firstPayload = createPayload({
        now: firstNow,
        gridPower: -190.46,
        solarPrimaryPower: 815.9,
        solarSecondaryPower: 433.4,
        batteryChargePower: 799
    });
    const initialRun = executeStats({ payload: firstPayload, now: firstNow });

    const staleNow = "2026-04-06T13:31:21.177Z";
    const stalePayload = createPayload({
        now: staleNow,
        gridPower: -210.3,
        solarPrimaryPower: 815.9,
        solarSecondaryPower: 431.6,
        batteryChargePower: 799,
        solarPrimaryTimestamp: firstNow
    });
    const staleRun = executeStats({
        payload: stalePayload,
        now: staleNow,
        contextState: initialRun.contextState
    });

    assert.equal(staleRun.outputMsg.derived.demand.raw, 238);
    assert.equal(staleRun.outputMsg.derived.demand.current, 260);
    assert.equal(staleRun.outputMsg.meta.sensorTiming.demand.confidence, 0);
    assert.equal(staleRun.outputMsg.derived.solar.rawPower, 1248);
    assert.equal(staleRun.outputMsg.derived.solar.livePower, 1249);
    assert.equal(staleRun.outputMsg.meta.sensorTiming.solar.confidence, 0);
    assert.equal(staleRun.outputMsg.meta.sensorTiming.demand.maxAgeMs, 60035);
    assert.equal(staleRun.outputMsg.meta.sensorTiming.demand.spreadMs, 60035);
    assert.equal(
        staleRun.outputMsg.meta.sensorTiming.demand.sensors.solarPrimary.timestamp,
        firstNow
    );
    assertApprox(staleRun.contextState.lastReliableDemand, 259.8399999999999);
    assertApprox(staleRun.contextState.lastReliableSolar, 1249.3);
    assert.deepEqual(staleRun.statuses, [
        {
            fill: "yellow",
            shape: "ring",
            text: "Solar: 1249W | Demand: 260W | sync 0%"
        }
    ]);
});

test("pins the negative-demand case by reusing the last reliable demand when a stale inverter reading makes the raw balance impossible", () => {
    const now = "2026-04-05T13:00:23.491Z";
    const payload = createPayload({
        now,
        gridPower: -67.01,
        solarPrimaryPower: 439.1,
        solarSecondaryPower: 292.8,
        batteryChargePower: 800,
        solarPrimaryTimestamp: secondsBefore(now, 60)
    });

    const { outputMsg, contextState, statuses } = executeStats({
        payload,
        now,
        contextState: {
            lastReliableDemand: 160,
            lastReliableSolar: 900,
            demandHistory: [150, 155, 160],
            solarHistory: [890, 905, 900]
        }
    });

    assert.equal(outputMsg.derived.demand.raw, -135);
    assert.equal(outputMsg.derived.demand.current, 160);
    assert.equal(outputMsg.meta.sensorTiming.demand.confidence, 0);
    assert.equal(outputMsg.meta.sensorTiming.demand.currentRaw, -135);
    assert.equal(outputMsg.meta.sensorTiming.demand.currentEstimate, 160);
    assert.equal(outputMsg.meta.sensorTiming.demand.maxAgeMs, 60000);
    assert.equal(outputMsg.meta.sensorTiming.demand.spreadMs, 60000);
    assertApprox(contextState.lastReliableDemand, 160);
    assertApprox(contextState.lastReliableSolar, 900);
    assert.deepEqual(
        contextState.demandHistory.map((value) => Math.round(value)),
        [150, 155, 160, 160]
    );
    assert.deepEqual(statuses, [
        {
            fill: "yellow",
            shape: "ring",
            text: "Solar: 900W | Demand: 158W | sync 0%"
        }
    ]);
});

test("keeps demand confidence high when idle zero-power components have old timestamps", () => {
    const now = "2026-04-06T23:20:00.000Z";
    const staleTimestamp = secondsBefore(now, 15 * 60);
    const payload = createPayload({
        now,
        gridPower: 120,
        solarPrimaryPower: 0,
        solarSecondaryPower: 0,
        batteryChargePower: 0,
        batteryDischargePower: 0,
        solarPrimaryTimestamp: staleTimestamp,
        solarSecondaryTimestamp: staleTimestamp,
        batteryChargeTimestamp: staleTimestamp,
        batteryDischargeTimestamp: staleTimestamp
    });

    const { outputMsg, statuses } = executeStats({ payload, now });

    assert.equal(outputMsg.derived.demand.raw, 120);
    assert.equal(outputMsg.derived.demand.current, 120);
    assert.equal(outputMsg.meta.sensorTiming.demand.confidence, 1);
    assert.equal(outputMsg.meta.sensorTiming.demand.maxAgeMs, 0);
    assert.equal(outputMsg.meta.sensorTiming.demand.spreadMs, 0);
    assert.equal(outputMsg.meta.sensorTiming.solar.confidence, 1);
    assert.equal(outputMsg.meta.sensorTiming.solar.maxAgeMs, null);
    assert.deepEqual(statuses, [
        {
            fill: "blue",
            shape: "dot",
            text: "Solar: 0W | Demand: 120W | sync 100%"
        }
    ]);
});

test("ignores stale zero battery-power timestamps even when battery setpoints are nonzero", () => {
    const now = "2026-04-06T12:20:00.000Z";
    const staleTimestamp = secondsBefore(now, 15 * 60);
    const payload = createPayload({
        now,
        gridPower: -80,
        solarPrimaryPower: 500,
        solarSecondaryPower: 180,
        batteryChargePower: 0,
        batteryDischargePower: 0,
        batteryChargeSetpoint: 800,
        batteryDischargeSetpoint: 800,
        batteryChargeTimestamp: staleTimestamp,
        batteryDischargeTimestamp: staleTimestamp
    });

    const { outputMsg } = executeStats({ payload, now });

    assert.equal(outputMsg.derived.demand.raw, 600);
    assert.equal(outputMsg.derived.demand.current, 600);
    assert.equal(outputMsg.meta.sensorTiming.demand.confidence, 1);
    assert.equal(outputMsg.meta.sensorTiming.demand.maxAgeMs, 0);
    assert.equal(outputMsg.meta.sensorTiming.demand.spreadMs, 0);
});

[
    {
        title: "keeps a stable night demand estimate when secondary solar is unavailable but discharge covers the load",
        now: "2026-04-05T22:00:13.490Z",
        gridPower: 258.43,
        solarPrimaryPower: 0,
        solarSecondaryPower: "unavailable",
        batteryChargePower: 0,
        batteryDischargePower: 268,
        expectedDemand: 526,
        expectedSolar: 0
    },
    {
        title: "keeps a stable late-night demand estimate when secondary solar is unavailable and discharge is modest",
        now: "2026-04-06T00:43:40.283Z",
        gridPower: 54.13,
        solarPrimaryPower: 0,
        solarSecondaryPower: "unavailable",
        batteryChargePower: 0,
        batteryDischargePower: 82,
        expectedDemand: 136,
        expectedSolar: 0
    },
    {
        title: "keeps a stable late-night demand estimate when secondary solar is unavailable and discharge is zero",
        now: "2026-04-06T00:43:40.283Z",
        gridPower: 54.13,
        solarPrimaryPower: 0,
        solarSecondaryPower: "unavailable",
        batteryChargePower: 0,
        batteryDischargePower: 0,
        expectedDemand: 54,
        expectedSolar: 0
    }
].forEach((scenario) => {
    test(scenario.title, () => {
        const payload = createPayload({
            now: scenario.now,
            gridPower: scenario.gridPower,
            solarPrimaryPower: scenario.solarPrimaryPower,
            solarSecondaryPower: scenario.solarSecondaryPower,
            batteryChargePower: scenario.batteryChargePower,
            batteryDischargePower: scenario.batteryDischargePower
        });

        const { outputMsg, statuses } = executeStats({
            payload,
            now: scenario.now
        });

        assert.equal(outputMsg.derived.demand.raw, scenario.expectedDemand);
        assert.equal(outputMsg.derived.demand.current, scenario.expectedDemand);
        assert.equal(outputMsg.meta.sensorTiming.demand.confidence, 1);
        assert.equal(outputMsg.derived.solar.rawPower, scenario.expectedSolar);
        assert.equal(outputMsg.derived.solar.livePower, scenario.expectedSolar);
        assert.equal(outputMsg.meta.sensorTiming.solar.confidence, 1);
        assert.equal(outputMsg.meta.sensorTiming.demand.maxAgeMs, 0);
        assert.equal(outputMsg.meta.sensorTiming.demand.spreadMs, 0);
        assert.equal(outputMsg.meta.sensorTiming.solar.sensors.solarSecondary.isValid, false);
        assert.equal(outputMsg.meta.sensorTiming.solar.sensors.solarSecondary.value, 0);
        assert.deepEqual(statuses, [
            {
                fill: "blue",
                shape: "dot",
                text: `Solar: ${scenario.expectedSolar}W | Demand: ${scenario.expectedDemand}W | sync 100%`
            }
        ]);
    });
});

[
    {
        title: "trusts aligned early-morning low solar values before stronger production starts",
        now: "2026-04-06T06:26:05.135Z",
        gridPower: 95.7,
        solarPrimaryPower: 36.7,
        solarSecondaryPower: 30.9,
        batteryChargePower: 0,
        expectedDemand: 163,
        expectedSolarRaw: 68,
        expectedSolar: 68,
        expectedDefensiveTarget: 143
    },
    {
        title: "trusts aligned morning solar values after sunrise instead of treating them as lagging data",
        now: "2026-04-06T07:52:28.585Z",
        gridPower: 73.32,
        solarPrimaryPower: 52.6,
        solarSecondaryPower: 37.2,
        batteryChargePower: 0,
        expectedDemand: 163,
        expectedSolarRaw: 90,
        expectedSolar: 90,
        expectedDefensiveTarget: 143
    }
].forEach((scenario) => {
    test(scenario.title, () => {
        const payload = createPayload({
            now: scenario.now,
            gridPower: scenario.gridPower,
            solarPrimaryPower: scenario.solarPrimaryPower,
            solarSecondaryPower: scenario.solarSecondaryPower,
            batteryChargePower: scenario.batteryChargePower
        });

        const { outputMsg, statuses } = executeStats({
            payload,
            now: scenario.now
        });

        assert.equal(outputMsg.derived.demand.raw, scenario.expectedDemand);
        assert.equal(outputMsg.derived.demand.current, scenario.expectedDemand);
        assert.equal(outputMsg.derived.demand.defensiveTarget, scenario.expectedDefensiveTarget);
        assert.equal(outputMsg.meta.sensorTiming.demand.confidence, 1);
        assert.equal(outputMsg.derived.solar.rawPower, scenario.expectedSolarRaw);
        assert.equal(outputMsg.derived.solar.livePower, scenario.expectedSolar);
        assert.equal(outputMsg.meta.sensorTiming.solar.confidence, 1);
        assert.equal(outputMsg.meta.sensorTiming.demand.maxAgeMs, 0);
        assert.equal(outputMsg.meta.sensorTiming.solar.maxAgeMs, 0);
        assert.deepEqual(statuses, [
            {
                fill: "blue",
                shape: "dot",
                text: `Solar: ${scenario.expectedSolar}W | Demand: ${scenario.expectedDemand}W | sync 100%`
            }
        ]);
    });
});

test("keeps using measured morning solar when forecast is optimistic but local shading limits production", () => {
    const now = "2026-04-06T07:52:28.585Z";
    const payload = createPayload({
        now,
        gridPower: 73.32,
        solarPrimaryPower: 52.6,
        solarSecondaryPower: 37.2,
        batteryChargePower: 0
    });

    const { outputMsg, statuses } = executeStats({
        payload,
        now,
        msg: {
            data: {
                forecast: {
                    nextHourWh: 300,
                    solarRemainingWh: 3000
                }
            }
        }
    });

    assert.equal(outputMsg.derived.demand.raw, 163);
    assert.equal(outputMsg.derived.demand.current, 163);
    assert.equal(outputMsg.derived.demand.defensiveTarget, 143);
    assert.equal(outputMsg.derived.solar.rawPower, 90);
    assert.equal(outputMsg.derived.solar.livePower, 90);
    assert.equal(outputMsg.meta.sensorTiming.solar.confidence, 1);
    assert.equal(outputMsg.data.forecast.nextHourWh, 300);
    assert.equal(outputMsg.data.forecast.solarRemainingWh, 3000);
    assert.deepEqual(statuses, [
        {
            fill: "blue",
            shape: "dot",
            text: "Solar: 90W | Demand: 163W | sync 100%"
        }
    ]);
});
