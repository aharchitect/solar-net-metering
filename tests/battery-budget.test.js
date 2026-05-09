const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { runFunctionNode } = require("./helpers/run-function-node");

const batteryBudgetScriptPath = path.join(__dirname, "..", "function-nodes", "battery-budget.js");

function createMsg(overrides = {}) {
    return {
        data: {
            battery: {
                availableWh: 600
            },
            forecast: {
                nextHourWh: 0
            },
            sun: {
                nextRising: "2026-04-07T04:00:00.000Z"
            }
        },
        ...overrides
    };
}

function executeBatteryBudget({
    msg = createMsg(),
    now = "2026-04-07T00:00:00.000Z",
    contextState
} = {}) {
    const execution = runFunctionNode(batteryBudgetScriptPath, {
        now,
        contextState,
        msg
    });

    return {
        ...execution,
        outputMsg: execution.result
    };
}

test("budgets battery energy across the hours until sunrise", () => {
    const { outputMsg, statuses, errors } = executeBatteryBudget();

    assert.equal(outputMsg.action.battery.discharge.forcedRate, 150);
    assert.equal(outputMsg.derived.forecast.hoursToUsableSolar, 4);
    assert.equal(outputMsg.derived.forecast.hoursToSunrise, "4.0");
    assert.equal(outputMsg.derived.forecast.budgetWindowReason, "sunrise");
    assert.deepEqual(errors, []);
    assert.deepEqual(statuses, [
        {
            fill: "blue",
            shape: "ring",
            text: "Budget: forced 150W over 4.0h (sunrise)"
        }
    ]);
});

test("uses a one hour budget window when near-term solar is already strong", () => {
    const { outputMsg, statuses } = executeBatteryBudget({
        msg: createMsg({
            data: {
                battery: {
                    availableWh: 600
                },
                forecast: {
                    nextHourWh: 250
                },
                sun: {
                    nextRising: "2026-04-07T04:00:00.000Z"
                }
            }
        })
    });

    assert.equal(outputMsg.action.battery.discharge.forcedRate, 600);
    assert.equal(outputMsg.derived.forecast.hoursToUsableSolar, 1);
    assert.equal(outputMsg.derived.forecast.hoursToSunrise, "4.0");
    assert.equal(outputMsg.derived.forecast.budgetWindowReason, "usable solar");
    assert.deepEqual(statuses, [
        {
            fill: "blue",
            shape: "ring",
            text: "Budget: forced 600W over 1.0h (usable solar)"
        }
    ]);
});

test("rejects invalid sunrise timestamps instead of falling back to epoch math", () => {
    const { outputMsg, statuses, errors } = executeBatteryBudget({
        msg: createMsg({
            data: {
                battery: {
                    availableWh: 600
                },
                forecast: {
                    nextHourWh: 0
                },
                sun: {
                    nextRising: "unknown"
                }
            }
        })
    });

    assert.equal(outputMsg, null);
    assert.deepEqual(statuses, [
        {
            fill: "red",
            shape: "ring",
            text: "Invalid sunrise timestamp"
        }
    ]);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, "Invalid sunrise timestamp: unknown");
});
