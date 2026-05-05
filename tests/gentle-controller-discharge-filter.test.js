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
        meta: {
            stability: {
                mode: "demand_unstable",
                demand: "unstable",
                solar: "stable"
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

test("starts discharging after weak morning solar was routed to the discharge path", () => {
    const { outputMsg, contextState, statuses } = executeDischargeFilter({
        msg: createMsg({
            data: {
                grid: {
                    power: 109
                },
                battery: {
                    dischargePower: 0
                }
            },
            derived: {
                demand: {
                    defensiveTarget: 180,
                    lowerBound: 160,
                    longTermMinimum: 160
                },
                solar: {
                    livePower: 71
                }
            }
        }),
        contextState: {
            lastCommand: 0
        },
        now: "2026-04-06T09:00:00.000"
    });

    assert.equal(outputMsg.action.battery.discharge.commandPower, 18);
    assert.equal(outputMsg.action.battery.discharge.requiredChange, -59);
    assert.equal(outputMsg.action.battery.discharge.importHoldActive, false);
    assert.equal(Math.round(contextState.lastCommand), 18);
    assert.deepEqual(statuses, [
        {
            fill: "green",
            shape: "dot",
            text: "Calculated Power (smoothed): 18W"
        }
    ]);
});

test("starts discharging after evening solar drop was routed to the discharge path", () => {
    const { outputMsg, contextState, statuses } = executeDischargeFilter({
        msg: createMsg({
            data: {
                grid: {
                    power: 165
                },
                battery: {
                    dischargePower: 0
                }
            },
            derived: {
                demand: {
                    defensiveTarget: 260,
                    lowerBound: 220,
                    longTermMinimum: 220
                },
                solar: {
                    livePower: 95
                }
            }
        }),
        contextState: {
            lastCommand: 0
        },
        now: "2026-04-06T18:30:00.000"
    });

    assert.equal(outputMsg.action.battery.discharge.commandPower, 35);
    assert.equal(outputMsg.action.battery.discharge.requiredChange, -115);
    assert.equal(outputMsg.action.battery.discharge.importHoldActive, false);
    assert.equal(Math.round(contextState.lastCommand), 35);
    assert.deepEqual(statuses, [
        {
            fill: "green",
            shape: "dot",
            text: "Calculated Power (smoothed): 35W"
        }
    ]);
});

[
    {
        title: "uses a 10W import buffer for stable-stable flat night demand",
        trendDirection: "flat",
        trend: 0,
        gridPower: 120,
        dischargePower: 0,
        lastCommand: 0,
        expectedRequiredChange: -170,
        expectedCommand: 51
    },
    {
        title: "uses a 10W import buffer for stable-stable slowly rising night demand",
        trendDirection: "up",
        trend: 8,
        gridPower: 120,
        dischargePower: 0,
        lastCommand: 0,
        expectedRequiredChange: -170,
        expectedCommand: 51
    },
    {
        title: "uses a 10W import buffer for stable-stable slowly falling night demand",
        trendDirection: "down",
        trend: -8,
        gridPower: 120,
        dischargePower: 0,
        lastCommand: 0,
        expectedRequiredChange: -170,
        expectedCommand: 51
    },
    {
        title: "nudges active discharge slightly upward near the 10W buffer when stable demand is slowly rising",
        trendDirection: "up",
        trend: 8,
        gridPower: 9,
        dischargePower: 50,
        lastCommand: 50,
        demandPower: 60,
        lowerBound: 30,
        expectedRequiredChange: -50,
        expectedCommand: 52
    },
    {
        title: "nudges active discharge slightly downward near the 10W buffer when stable demand is slowly falling",
        trendDirection: "down",
        trend: -8,
        gridPower: 9,
        dischargePower: 50,
        lastCommand: 50,
        demandPower: 60,
        lowerBound: 30,
        expectedRequiredChange: -50,
        expectedCommand: 47
    },
    {
        title: "increases active discharge when stable flat demand still imports 50W",
        trendDirection: "flat",
        trend: 0,
        gridPower: 50,
        dischargePower: 50,
        lastCommand: 50,
        demandPower: 100,
        lowerBound: 30,
        expectedRequiredChange: -90,
        expectedCommand: 62
    },
    {
        title: "increases active discharge more when stable rising demand still imports 50W",
        trendDirection: "up",
        trend: 8,
        gridPower: 50,
        dischargePower: 50,
        lastCommand: 50,
        demandPower: 100,
        lowerBound: 30,
        expectedRequiredChange: -90,
        expectedCommand: 64
    },
    {
        title: "increases active discharge more cautiously when stable falling demand still imports 50W",
        trendDirection: "down",
        trend: -8,
        gridPower: 50,
        dischargePower: 50,
        lastCommand: 50,
        demandPower: 100,
        lowerBound: 30,
        expectedRequiredChange: -90,
        expectedCommand: 62
    }
].forEach((scenario) => {
    test(scenario.title, () => {
        const { outputMsg, contextState } = executeDischargeFilter({
            msg: createMsg({
                data: {
                    grid: {
                        power: scenario.gridPower
                    },
                    battery: {
                        dischargePower: scenario.dischargePower
                    }
                },
                derived: {
                    demand: {
                        defensiveTarget: scenario.demandPower ?? 180,
                        lowerBound: scenario.lowerBound ?? 160,
                        longTermMinimum: scenario.lowerBound ?? 160,
                        trend: scenario.trend,
                        trendDirection: scenario.trendDirection,
                        trendChanges: 0,
                        stdDev: 12
                    },
                    solar: {
                        livePower: 0
                    }
                },
                meta: {
                    stability: {
                        mode: "stable_stable",
                        demand: "stable",
                        solar: "stable"
                    }
                }
            }),
            contextState: {
                lastCommand: scenario.lastCommand
            }
        });

        assert.equal(outputMsg.action.battery.discharge.targetImportBuffer, 10);
        assert.equal(
            outputMsg.action.battery.discharge.requiredChange,
            scenario.expectedRequiredChange
        );
        assert.equal(outputMsg.action.battery.discharge.commandPower, scenario.expectedCommand);
        assert.equal(Math.round(contextState.lastCommand), scenario.expectedCommand);
    });
});

test("keeps the conservative 50W import buffer when demand is unstable", () => {
    const { outputMsg, contextState } = executeDischargeFilter({
        msg: createMsg({
            data: {
                grid: {
                    power: 120
                },
                battery: {
                    dischargePower: 0
                }
            },
            derived: {
                demand: {
                    defensiveTarget: 180,
                    lowerBound: 160,
                    longTermMinimum: 160,
                    trend: 40,
                    trendDirection: "up",
                    trendChanges: 3,
                    stdDev: 95
                },
                solar: {
                    livePower: 0
                }
            },
            meta: {
                stability: {
                    mode: "demand_unstable",
                    demand: "unstable",
                    solar: "stable"
                }
            }
        }),
        contextState: {
            lastCommand: 0
        }
    });

    assert.equal(outputMsg.action.battery.discharge.targetImportBuffer, 50);
    assert.equal(outputMsg.action.battery.discharge.requiredChange, -130);
    assert.equal(outputMsg.action.battery.discharge.commandPower, 39);
    assert.equal(Math.round(contextState.lastCommand), 39);
});
