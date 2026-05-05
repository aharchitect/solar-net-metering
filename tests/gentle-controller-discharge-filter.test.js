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

test("stops discharge immediately when the decision node requests a stop", () => {
    const { outputMsg, contextState, statuses } = executeDischargeFilter({
        msg: createMsg({
            action: {
                battery: {
                    discharge: {
                        forcedRate: 300,
                        stopRequested: true,
                        blockedByLowSoc: false
                    }
                }
            }
        }),
        contextState: {
            lastCommand: 120
        }
    });

    assert.equal(outputMsg.action.battery.discharge.commandPower, 0);
    assert.equal(outputMsg.action.battery.discharge.isStable, true);
    assert.equal(contextState.lastCommand, 0);
    assert.deepEqual(statuses, [
        {
            fill: "red",
            shape: "ring",
            text: "Discharge stop requested"
        }
    ]);
});

test("stops discharge immediately when low SoC blocks discharge", () => {
    const { outputMsg, contextState, statuses } = executeDischargeFilter({
        msg: createMsg({
            action: {
                battery: {
                    discharge: {
                        forcedRate: 300,
                        stopRequested: false,
                        blockedByLowSoc: true
                    }
                }
            }
        }),
        contextState: {
            lastCommand: 120
        }
    });

    assert.equal(outputMsg.action.battery.discharge.commandPower, 0);
    assert.equal(outputMsg.action.battery.discharge.gridPower, 18);
    assert.equal(contextState.lastCommand, 0);
    assert.deepEqual(statuses, [
        {
            fill: "red",
            shape: "ring",
            text: "Discharge blocked by low SoC"
        }
    ]);
});

test("keeps the sustain floor when demand is near the learned baseline", () => {
    const { outputMsg, contextState, statuses } = executeDischargeFilter({
        msg: createMsg({
            data: {
                grid: {
                    power: 20
                },
                battery: {
                    dischargePower: 120
                }
            },
            derived: {
                demand: {
                    defensiveTarget: 120,
                    lowerBound: 160,
                    longTermMinimum: 160
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
    assert.equal(outputMsg.action.battery.discharge.sustainActive, true);
    assert.equal(outputMsg.action.battery.discharge.sustainFloor, 120);
    assert.equal(outputMsg.action.battery.discharge.importHoldActive, false);
    assert.equal(Math.round(contextState.lastCommand), 120);
    assert.deepEqual(statuses, [
        {
            fill: "green",
            shape: "dot",
            text: "Discharge sustain @ 120W"
        }
    ]);
});

test("backs off quickly when discharge causes grid export", () => {
    const { outputMsg, contextState } = executeDischargeFilter({
        msg: createMsg({
            data: {
                grid: {
                    power: -40
                },
                battery: {
                    dischargePower: 120
                }
            }
        }),
        contextState: {
            lastCommand: 120
        }
    });

    assert.equal(outputMsg.action.battery.discharge.commandPower, 30);
    assert.equal(outputMsg.action.battery.discharge.importHoldActive, false);
    assert.equal(Math.round(contextState.lastCommand), 30);
});

test("limits discharge command to the forced discharge budget", () => {
    const { outputMsg, contextState } = executeDischargeFilter({
        msg: createMsg({
            data: {
                grid: {
                    power: 80
                },
                battery: {
                    dischargePower: 0
                }
            },
            derived: {
                demand: {
                    defensiveTarget: 500,
                    lowerBound: 300,
                    longTermMinimum: 300
                },
                solar: {
                    livePower: 0
                }
            },
            action: {
                battery: {
                    discharge: {
                        forcedRate: 40,
                        stopRequested: false,
                        blockedByLowSoc: false
                    }
                }
            }
        }),
        contextState: {
            lastCommand: 0
        }
    });

    assert.equal(outputMsg.action.battery.discharge.commandPower, 100);
    assert.equal(outputMsg.action.battery.discharge.importHoldActive, false);
    assert.equal(Math.round(contextState.lastCommand), 100);
});

test("emits no command when an idle system is inside the demand deadband", () => {
    const { outputMsg, result, contextState, statuses } = executeDischargeFilter({
        msg: createMsg({
            data: {
                grid: {
                    power: 20
                },
                battery: {
                    dischargePower: 0
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
            lastCommand: 0
        }
    });

    assert.equal(result, null);
    assert.equal(outputMsg, null);
    assert.equal(contextState.lastCommand, 0);
    assert.deepEqual(statuses, [
        {
            fill: "green",
            shape: "dot",
            text: "Done (deadband) - Stable power - finish (calculated change is -40W, grid power: 20W)"
        }
    ]);
});
