const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { runFunctionNode } = require("./helpers/run-function-node");

const decisionScriptPath = path.join(
    __dirname,
    "..",
    "function-nodes",
    "decision-day-night-charge-or-discharge.js"
);

function createData(overrides = {}) {
    return {
        sun: {
            aboveHorizon: true,
            nextRising: null
        },
        battery: {
            soc: 64,
            minSoc: 15
        },
        forecast: {
            solarRemainingWh: 1000
        },
        ...overrides
    };
}

function createDerived(overrides = {}) {
    return {
        solar: {
            livePower: 0
        },
        ...overrides
    };
}

function executeDecision({ data = createData(), derived = createDerived(), now } = {}) {
    const execution = runFunctionNode(decisionScriptPath, {
        now: now || "2026-04-06T12:00:00.000Z",
        msg: {
            data,
            derived
        }
    });
    const [toCharge, toDischarge] = execution.result;

    return {
        ...execution,
        toCharge,
        toDischarge
    };
}

function toPlain(value) {
    return JSON.parse(JSON.stringify(value));
}

test("routes to charge during the day when solar power is available and forecast remains", () => {
    const { toCharge, toDischarge, statuses } = executeDecision({
        derived: createDerived({
            solar: {
                livePower: 320
            }
        })
    });

    assert.ok(toCharge);
    assert.equal(toCharge.derived.solar.livePower, 320);
    assert.deepEqual(toPlain(toCharge.action.decision), {
        isSolarDayOver: false,
        batteryHasReserve: true,
        nightLowSocBlock: false,
        dischargeStopThreshold: 15
    });
    assert.equal(toDischarge, null);
    assert.deepEqual(statuses, [
        {
            fill: "yellow",
            shape: "dot",
            text: "Charge - Day/Solar: remaing solar 1000Wh"
        }
    ]);
});

test("routes to discharge at night when the battery has reserve", () => {
    const { toCharge, toDischarge, statuses } = executeDecision({
        data: createData({
            sun: {
                aboveHorizon: false,
                nextRising: "2026-04-07T04:33:00.000Z"
            }
        })
    });

    assert.equal(toCharge, null);
    assert.ok(toDischarge);
    assert.deepEqual(toPlain(toDischarge.action.decision), {
        isSolarDayOver: true,
        batteryHasReserve: true,
        nightLowSocBlock: false,
        dischargeStopThreshold: 15
    });
    assert.deepEqual(statuses, [
        {
            fill: "blue",
            shape: "dot",
            text: "Discharge - Night, remaing solar 1000Wh, Solar Day is Over: true, battery has res: true"
        }
    ]);
});

test("routes to discharge during the day when the remaining solar forecast is negligible", () => {
    const { toCharge, toDischarge, statuses } = executeDecision({
        data: createData({
            forecast: {
                solarRemainingWh: 40
            }
        }),
        derived: createDerived({
            solar: {
                livePower: 120
            }
        })
    });

    assert.equal(toCharge, null);
    assert.ok(toDischarge);
    assert.deepEqual(statuses, [
        {
            fill: "blue",
            shape: "dot",
            text: "Discharge - Night, remaing solar 40Wh, Solar Day is Over: true, battery has res: true"
        }
    ]);
});

test("does not discharge at night when the battery is at the minimum reserve", () => {
    const { toCharge, toDischarge, statuses, msg } = executeDecision({
        data: createData({
            sun: {
                aboveHorizon: false,
                nextRising: "2026-04-07T04:33:00.000Z"
            },
            battery: {
                soc: 15,
                minSoc: 15
            }
        })
    });

    assert.equal(toCharge, null);
    assert.equal(toDischarge, null);
    assert.deepEqual(toPlain(msg.action.decision), {
        isSolarDayOver: true,
        batteryHasReserve: false,
        nightLowSocBlock: true,
        dischargeStopThreshold: 15
    });
    assert.deepEqual(statuses, [
        {
            fill: "red",
            shape: "dot",
            text: "Empty Battery, no solar power: 0W, solar forecast 1000Wh, battery soc: 15"
        }
    ]);
});

test("routes nowhere during the day when no solar power is available", () => {
    const { toCharge, toDischarge, statuses, msg } = executeDecision();

    assert.equal(toCharge, null);
    assert.equal(toDischarge, null);
    assert.deepEqual(toPlain(msg.action.decision), {
        isSolarDayOver: false,
        batteryHasReserve: true,
        nightLowSocBlock: false,
        dischargeStopThreshold: 15
    });
    assert.deepEqual(statuses, [
        {
            fill: "red",
            shape: "dot",
            text: "Empty Battery, no solar power: 0W, solar forecast 1000Wh, battery soc: 64"
        }
    ]);
});
