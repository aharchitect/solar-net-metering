const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { runFunctionNode } = require("./helpers/run-function-node");

const dischargeFilterScriptPath = path.join(
    __dirname,
    "..",
    "function-nodes",
    "gentle-controller-discharge-filter.js"
);

function createMsg(overrides = {}) {
    return {
        data: {
            grid: {
                power: 18
            },
            battery: {
                dischargePower: 120
            }
        },
        derived: {
            demand: {
                defensiveTarget: 140,
                lowerBound: 90,
                longTermMinimum: 90
            },
            solar: {
                livePower: 0
            }
        },
        action: {
            battery: {
                discharge: {
                    forcedRate: 300,
                    stopRequested: false,
                    blockedByLowSoc: false
                }
            }
        },
        ...overrides
    };
}

function executeDischargeFilter({ msg = createMsg(), contextState, now } = {}) {
    const execution = runFunctionNode(dischargeFilterScriptPath, {
        now: now || "2026-04-06T22:00:00.000Z",
        contextState,
        msg
    });

    return {
        ...execution,
        outputMsg: execution.result
    };
}

test("does not reduce active discharge while grid import is above the target buffer", () => {
    const { outputMsg, contextState, statuses } = executeDischargeFilter({
        msg: createMsg({
            data: {
                grid: {
                    power: 60
                },
                battery: {
                    dischargePower: 120
                }
            },
            derived: {
                demand: {
                    defensiveTarget: 90,
                    lowerBound: 90,
                    longTermMinimum: 90
                },
                solar: {
                    livePower: 0
                }
            }
        }),
        contextState: {
            lastCommand: 120
        }
    });

    assert.equal(outputMsg.action.battery.discharge.commandPower, 120);
    assert.equal(outputMsg.action.battery.discharge.importHoldActive, true);
    assert.equal(Math.round(contextState.lastCommand), 120);
    assert.deepEqual(statuses, [
        {
            fill: "green",
            shape: "dot",
            text: "Discharge import hold @ 120W"
        }
    ]);
});

test("allows active discharge to ease down when grid import stays below the target buffer", () => {
    const { outputMsg, contextState } = executeDischargeFilter({
        msg: createMsg({
            data: {
                grid: {
                    power: 18
                },
                battery: {
                    dischargePower: 120
                }
            },
            derived: {
                demand: {
                    defensiveTarget: 90,
                    lowerBound: 90,
                    longTermMinimum: 90
                },
                solar: {
                    livePower: 0
                }
            }
        }),
        contextState: {
            lastCommand: 120
        }
    });

    assert.equal(outputMsg.action.battery.discharge.commandPower, 96);
    assert.equal(outputMsg.action.battery.discharge.importHoldActive, false);
    assert.equal(Math.round(contextState.lastCommand), 96);
});
