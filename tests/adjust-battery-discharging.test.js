const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { runFunctionNode } = require("./helpers/run-function-node");

const adjustDischargingScriptPath = path.join(
    __dirname,
    "..",
    "function-nodes",
    "adjust-battery-discharging.js"
);

function createData(overrides = {}) {
    return {
        battery: {
            dischargeSetpoint: 80
        },
        forecast: {
            nextHourWh: 0
        },
        ...overrides
    };
}

function createActionDischarge(overrides = {}) {
    return {
        commandPower: 120,
        requiredChange: -120,
        isStable: false,
        gridPower: 50,
        ...overrides
    };
}

function executeAdjustDischarging({
    data = createData(),
    actionDischarge = createActionDischarge(),
    now
} = {}) {
    const execution = runFunctionNode(adjustDischargingScriptPath, {
        now: now || "2026-04-06T22:00:00.000Z",
        msg: {
            data,
            action: {
                battery: {
                    discharge: actionDischarge
                }
            }
        }
    });

    const [hardwareCmd] = execution.result || [];

    return {
        ...execution,
        hardwareCmd
    };
}

function toPlain(value) {
    if (value === null || value === undefined) {
        return value;
    }

    return JSON.parse(JSON.stringify(value));
}

test("emits a hardware discharge command from msg.action.battery.discharge.commandPower", () => {
    const { hardwareCmd, statuses } = executeAdjustDischarging({
        actionDischarge: createActionDischarge({
            commandPower: 120
        })
    });

    assert.deepEqual(toPlain(hardwareCmd), { payload: 120 });
    assert.deepEqual(statuses, [
        {
            fill: "blue",
            shape: "dot",
            text: "target: 120W"
        }
    ]);
});

test("does not emit hardware command when the setpoint change is inside the deadband", () => {
    const { hardwareCmd, statuses } = executeAdjustDischarging({
        data: createData({
            battery: {
                dischargeSetpoint: 116
            }
        }),
        actionDischarge: createActionDischarge({
            commandPower: 120
        })
    });

    assert.equal(hardwareCmd, null);
    assert.deepEqual(statuses, [
        {
            fill: "blue",
            shape: "dot",
            text: "target: 120W"
        }
    ]);
});

test("emits a stop command when target discharge is zero and current setpoint is active", () => {
    const { hardwareCmd, statuses } = executeAdjustDischarging({
        data: createData({
            battery: {
                dischargeSetpoint: 120
            }
        }),
        actionDischarge: createActionDischarge({
            commandPower: 0
        })
    });

    assert.deepEqual(toPlain(hardwareCmd), { payload: 0 });
    assert.deepEqual(statuses, [
        {
            fill: "blue",
            shape: "dot",
            text: "target: 0W"
        }
    ]);
});

test("uses a ring status while next-hour solar is expected", () => {
    const { hardwareCmd, statuses } = executeAdjustDischarging({
        data: createData({
            forecast: {
                nextHourWh: 120
            }
        }),
        actionDischarge: createActionDischarge({
            commandPower: 140
        })
    });

    assert.deepEqual(toPlain(hardwareCmd), { payload: 140 });
    assert.deepEqual(statuses, [
        {
            fill: "blue",
            shape: "ring",
            text: "target: 140W"
        }
    ]);
});

test("rounds fractional discharge commands before sending hardware output", () => {
    const { hardwareCmd, statuses } = executeAdjustDischarging({
        actionDischarge: createActionDischarge({
            commandPower: 123.6
        })
    });

    assert.deepEqual(toPlain(hardwareCmd), { payload: 124 });
    assert.deepEqual(statuses, [
        {
            fill: "blue",
            shape: "dot",
            text: "target: 124W"
        }
    ]);
});

test("returns null and reports missing fields when mandatory contract data is absent", () => {
    const execution = runFunctionNode(adjustDischargingScriptPath, {
        now: "2026-04-06T22:00:00.000Z",
        msg: {
            data: {
                battery: {
                    dischargeSetpoint: 80
                },
                forecast: {}
            },
            action: {
                battery: {
                    discharge: {
                        commandPower: 120
                    }
                }
            }
        }
    });

    assert.equal(execution.result, null);
    assert.deepEqual(execution.statuses, [
        {
            fill: "red",
            shape: "ring",
            text: "Missing data: data.forecast.nextHourWh"
        }
    ]);
    assert.equal(
        execution.errors[0].message,
        "Missing mandatory message fields: data.forecast.nextHourWh"
    );
});
