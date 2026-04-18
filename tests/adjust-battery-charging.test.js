const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { runFunctionNode } = require("./helpers/run-function-node");

const adjustChargingScriptPath = path.join(
    __dirname,
    "..",
    "function-nodes",
    "adjust-battery-charging.js"
);

function createData(overrides = {}) {
    return {
        grid: {
            power: -120
        },
        battery: {
            soc: 64,
            socLimit: 100,
            chargePower: 500,
            chargeSetpoint: 500,
            chargeHardwareMaxPower: 800
        },
        ...overrides
    };
}

function createActionCharge(overrides = {}) {
    return {
        commandPower: 600,
        targetPower: 600,
        ruleApplied: "Anti-Export",
        clampReason: "None",
        ...overrides
    };
}

function executeAdjustCharging({
    data = createData(),
    actionCharge = createActionCharge(),
    now
} = {}) {
    const execution = runFunctionNode(adjustChargingScriptPath, {
        now: now || "2026-04-06T12:00:00.000Z",
        msg: {
            data,
            action: {
                charge: actionCharge
            }
        }
    });
    const [hardwareCmd, reasonMsg, logMsg] = execution.result;

    return {
        ...execution,
        hardwareCmd,
        reasonMsg,
        logMsg
    };
}

function toPlain(value) {
    if (value === null) {
        return null;
    }

    return JSON.parse(JSON.stringify(value));
}

test("emits a hardware charge command from msg.action.charge.commandPower", () => {
    const { hardwareCmd, reasonMsg, logMsg, statuses } = executeAdjustCharging({
        actionCharge: createActionCharge({
            commandPower: 650
        })
    });

    assert.deepEqual(toPlain(hardwareCmd), { payload: 650 });
    assert.deepEqual(toPlain(reasonMsg), { payload: "Adjusting normally" });
    assert.equal(logMsg.payload.grid, -120);
    assert.equal(logMsg.payload.soc, 64);
    assert.equal(logMsg.payload.targetCharge, 650);
    assert.equal(logMsg.payload.reason, "Adjusting normally");
    assert.deepEqual(statuses, [
        {
            fill: "green",
            shape: "dot",
            text: "650W (Adjusting normally)"
        }
    ]);
});

test("does not emit hardware command when the setpoint change is inside the deadband", () => {
    const { hardwareCmd, reasonMsg, logMsg, statuses } = executeAdjustCharging({
        data: createData({
            battery: {
                soc: 64,
                socLimit: 100,
                chargePower: 595,
                chargeSetpoint: 595,
                chargeHardwareMaxPower: 800
            }
        }),
        actionCharge: createActionCharge({
            commandPower: 600
        })
    });

    assert.equal(hardwareCmd, null);
    assert.deepEqual(toPlain(reasonMsg), { payload: "No change - no need to adjust" });
    assert.equal(logMsg.payload.targetCharge, 600);
    assert.equal(logMsg.payload.reason, "Adjusting normally");
    assert.deepEqual(statuses, [
        {
            fill: "green",
            shape: "dot",
            text: "600W (No change - no need to adjust)"
        }
    ]);
});

test("clamps command to hardware maximum", () => {
    const { hardwareCmd, reasonMsg, logMsg, statuses } = executeAdjustCharging({
        data: createData({
            battery: {
                soc: 64,
                socLimit: 100,
                chargePower: 500,
                chargeSetpoint: 500,
                chargeHardwareMaxPower: 800
            }
        }),
        actionCharge: createActionCharge({
            commandPower: 1000
        })
    });

    assert.deepEqual(toPlain(hardwareCmd), { payload: 800 });
    assert.deepEqual(toPlain(reasonMsg), { payload: "MAX_CHARGE_OVERFLOW" });
    assert.equal(logMsg.payload.targetCharge, 800);
    assert.equal(logMsg.payload.reason, "MAX_CHARGE_OVERFLOW");
    assert.deepEqual(statuses, [
        {
            fill: "green",
            shape: "dot",
            text: "800W (MAX_CHARGE_OVERFLOW)"
        }
    ]);
});

test("allows a 1000W charge command when both normalized charge limits are 1000W", () => {
    const { hardwareCmd, reasonMsg, logMsg, statuses } = executeAdjustCharging({
        data: createData({
            battery: {
                soc: 64,
                socLimit: 100,
                chargePower: 800,
                chargeSetpoint: 800,
                chargeMaxPower: 1000,
                chargeHardwareMaxPower: 1000
            }
        }),
        actionCharge: createActionCharge({
            commandPower: 1000
        })
    });

    assert.deepEqual(toPlain(hardwareCmd), { payload: 1000 });
    assert.deepEqual(toPlain(reasonMsg), { payload: "Adjusting normally" });
    assert.equal(logMsg.payload.targetCharge, 1000);
    assert.equal(logMsg.payload.reason, "Adjusting normally");
    assert.deepEqual(statuses, [
        {
            fill: "green",
            shape: "dot",
            text: "1000W (Adjusting normally)"
        }
    ]);
});

test("stops charging when battery is effectively full", () => {
    const { hardwareCmd, reasonMsg, logMsg, statuses } = executeAdjustCharging({
        data: createData({
            battery: {
                soc: 99.2,
                socLimit: 100,
                chargePower: 500,
                chargeSetpoint: 500,
                chargeHardwareMaxPower: 800
            }
        }),
        actionCharge: createActionCharge({
            commandPower: 600
        })
    });

    assert.deepEqual(toPlain(hardwareCmd), { payload: 0 });
    assert.deepEqual(toPlain(reasonMsg), { payload: "BATTERY_FULL_OVERFLOW" });
    assert.equal(logMsg.payload.soc, 99.2);
    assert.equal(logMsg.payload.targetCharge, 0);
    assert.equal(logMsg.payload.reason, "BATTERY_FULL_OVERFLOW");
    assert.deepEqual(statuses, [
        {
            fill: "green",
            shape: "dot",
            text: "0W (BATTERY_FULL_OVERFLOW)"
        }
    ]);
});
