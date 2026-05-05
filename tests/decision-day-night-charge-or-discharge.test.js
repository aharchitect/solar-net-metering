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
            minSoc: 15,
            socLimit: 100
        },
        forecast: {
            solarRemainingWh: 1000,
            nextHourWh: 300
        },
        ...overrides
    };
}

function createDerived(overrides = {}) {
    return {
        solar: {
            livePower: 0
        },
        demand: {
            defensiveTarget: 0
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

test("does not charge before sunrise when SoC is below minimum even if the daily forecast is high", () => {
    const { toCharge, toDischarge, statuses, msg } = executeDecision({
        now: "2026-04-06T03:31:00.000Z",
        data: createData({
            sun: {
                aboveHorizon: false,
                nextRising: "2026-04-06T04:33:00.000Z"
            },
            battery: {
                soc: 4,
                minSoc: 5
            },
            forecast: {
                solarRemainingWh: 6000,
                nextHourWh: 0
            }
        }),
        derived: createDerived({
            solar: {
                livePower: 120
            }
        })
    });

    assert.equal(toCharge, null);
    assert.equal(toDischarge, null);
    assert.deepEqual(toPlain(msg.action.decision), {
        isSolarDayOver: true,
        batteryHasReserve: false,
        nightLowSocBlock: true,
        dischargeStopThreshold: 5
    });
    assert.deepEqual(toPlain(msg.action.battery.discharge), {
        stopRequested: true,
        blockedByLowSoc: true
    });
    assert.deepEqual(statuses, [
        {
            fill: "red",
            shape: "dot",
            text: "Empty Battery, no solar power: 120W, solar forecast 6000Wh, battery soc: 4"
        }
    ]);
});

test("does not charge low SoC from daily forecast when next-hour solar is not usable yet", () => {
    const { toCharge, toDischarge, statuses, msg } = executeDecision({
        now: "2026-04-06T03:31:00.000Z",
        data: createData({
            sun: {
                aboveHorizon: true,
                nextRising: "2026-04-06T04:33:00.000Z"
            },
            battery: {
                soc: 4,
                minSoc: 5
            },
            forecast: {
                solarRemainingWh: 6000,
                nextHourWh: 0
            }
        }),
        derived: createDerived({
            solar: {
                livePower: 120
            }
        })
    });

    assert.equal(toCharge, null);
    assert.equal(toDischarge, null);
    assert.deepEqual(toPlain(msg.action.decision), {
        isSolarDayOver: true,
        batteryHasReserve: false,
        nightLowSocBlock: true,
        dischargeStopThreshold: 5
    });
    assert.deepEqual(toPlain(msg.action.battery.discharge), {
        stopRequested: true,
        blockedByLowSoc: true
    });
    assert.deepEqual(statuses, [
        {
            fill: "red",
            shape: "dot",
            text: "Empty Battery, no solar power: 120W, solar forecast 6000Wh, battery soc: 4"
        }
    ]);
});

test("routes to discharge during weak morning solar when battery has 30 percent reserve above minimum", () => {
    const { toCharge, toDischarge, statuses } = executeDecision({
        now: "2026-04-06T09:00:00.000",
        data: createData({
            sun: {
                aboveHorizon: true,
                nextRising: null
            },
            battery: {
                soc: 38,
                minSoc: 5
            },
            forecast: {
                solarRemainingWh: 6000,
                nextHourWh: 200
            }
        }),
        derived: createDerived({
            solar: {
                livePower: 71
            },
            demand: {
                defensiveTarget: 180
            }
        })
    });

    assert.equal(toCharge, null);
    assert.ok(toDischarge);
    assert.deepEqual(statuses, [
        {
            fill: "blue",
            shape: "dot",
            text: "Discharge - Weak morning solar, solar 71W, demand 180W, battery soc: 38"
        }
    ]);
});

test("routes to charge during weak morning solar when battery reserve is not 30 percent above minimum", () => {
    const { toCharge, toDischarge, statuses } = executeDecision({
        now: "2026-04-06T09:00:00.000",
        data: createData({
            sun: {
                aboveHorizon: true,
                nextRising: null
            },
            battery: {
                soc: 34,
                minSoc: 5
            },
            forecast: {
                solarRemainingWh: 6000,
                nextHourWh: 200
            }
        }),
        derived: createDerived({
            solar: {
                livePower: 71
            },
            demand: {
                defensiveTarget: 180
            }
        })
    });

    assert.ok(toCharge);
    assert.equal(toDischarge, null);
    assert.deepEqual(statuses, [
        {
            fill: "yellow",
            shape: "dot",
            text: "Charge - Day/Solar: remaing solar 6000Wh"
        }
    ]);
});

test("routes to discharge after 6PM when solar is weak and battery is within 20 percent of max SoC", () => {
    const { toCharge, toDischarge, statuses } = executeDecision({
        now: "2026-04-06T18:30:00.000",
        data: createData({
            sun: {
                aboveHorizon: true,
                nextRising: null
            },
            battery: {
                soc: 82,
                minSoc: 5,
                socLimit: 100
            },
            forecast: {
                solarRemainingWh: 1200,
                nextHourWh: 120
            }
        }),
        derived: createDerived({
            solar: {
                livePower: 95
            },
            demand: {
                defensiveTarget: 260
            }
        })
    });

    assert.equal(toCharge, null);
    assert.ok(toDischarge);
    assert.deepEqual(statuses, [
        {
            fill: "blue",
            shape: "dot",
            text: "Discharge - Evening solar drop, solar 95W, demand 260W, battery soc: 82"
        }
    ]);
});

test("keeps charging after 6PM when battery is below the evening high-SoC threshold", () => {
    const { toCharge, toDischarge, statuses } = executeDecision({
        now: "2026-04-06T18:30:00.000",
        data: createData({
            sun: {
                aboveHorizon: true,
                nextRising: null
            },
            battery: {
                soc: 79,
                minSoc: 5,
                socLimit: 100
            },
            forecast: {
                solarRemainingWh: 600,
                nextHourWh: 120
            }
        }),
        derived: createDerived({
            solar: {
                livePower: 95
            },
            demand: {
                defensiveTarget: 260
            }
        })
    });

    assert.ok(toCharge);
    assert.equal(toDischarge, null);
    assert.deepEqual(statuses, [
        {
            fill: "yellow",
            shape: "dot",
            text: "Charge - Day/Solar: remaing solar 600Wh"
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
