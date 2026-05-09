const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { runFunctionNode } = require("./helpers/run-function-node");

const controllerScriptPath = path.join(
    __dirname,
    "..",
    "function-nodes",
    "ControllerDayHandling.js"
);

function entity(state, attributes = {}) {
    return {
        state: String(state),
        attributes
    };
}

function parseNumericState(value, fallback = 0) {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function createPayload({
    gridPower,
    solarPrimaryPower,
    solarSecondaryPower,
    batteryInflow = 0,
    batteryDischargePower = 0,
    maxChargePower = 800,
    maxChargePowerAttributes = {},
    soc = 64,
    minSoc = 15,
    socLimit = 100,
    availableWh = 0,
    currentSetInflow = 0
}) {
    return {
        "sensor.smartmeter_keller_sml_watt_summe": entity(gridPower),
        "sensor.wechselrichter_ac_leistung": entity(solarPrimaryPower),
        "sensor.hoymiles600_power": entity(solarSecondaryPower),
        "sensor.solarflow_800_pro_grid_input_power": entity(batteryInflow),
        "sensor.solarflow_800_pro_output_home_power": entity(batteryDischargePower),
        "sensor.solarflow_800_pro_charge_max_limit": entity(
            maxChargePower,
            maxChargePowerAttributes
        ),
        "sensor.solarflow_800_pro_electric_level": entity(soc),
        "number.solarflow_800_pro_min_soc": entity(minSoc),
        "number.solarflow_800_pro_soc_set": entity(socLimit),
        "sensor.solarflow_800_pro_available_kwh": entity(availableWh / 1000),
        "number.solarflow_800_pro_input_limit": entity(currentSetInflow)
    };
}

function createDataFromPayload(payload, stats = {}) {
    const gridPower = parseNumericState(
        payload["sensor.smartmeter_keller_sml_watt_summe"]?.state,
        0
    );
    const solarPrimaryPower = parseNumericState(
        payload["sensor.wechselrichter_ac_leistung"]?.state,
        0
    );
    const solarSecondaryPower = parseNumericState(payload["sensor.hoymiles600_power"]?.state, 0);
    const batteryChargePower = parseNumericState(
        payload["sensor.solarflow_800_pro_grid_input_power"]?.state,
        0
    );
    const batteryDischargePower = parseNumericState(
        payload["sensor.solarflow_800_pro_output_home_power"]?.state,
        0
    );
    const chargeMaxPower = parseNumericState(
        payload["sensor.solarflow_800_pro_charge_max_limit"]?.state,
        800
    );
    const chargeHardwareMaxPower = parseNumericState(
        payload["sensor.solarflow_800_pro_charge_max_limit"]?.attributes?.max,
        chargeMaxPower
    );

    return {
        grid: {
            power: gridPower
        },
        solar: {
            primaryPower: solarPrimaryPower,
            secondaryPower: solarSecondaryPower,
            totalPower: solarPrimaryPower + solarSecondaryPower
        },
        battery: {
            soc: parseNumericState(payload["sensor.solarflow_800_pro_electric_level"]?.state, 0),
            minSoc: parseNumericState(payload["number.solarflow_800_pro_min_soc"]?.state, 15),
            socLimit: parseNumericState(payload["number.solarflow_800_pro_soc_set"]?.state, 100),
            availableWh:
                parseNumericState(payload["sensor.solarflow_800_pro_available_kwh"]?.state, 0) *
                1000,
            chargePower: batteryChargePower,
            dischargePower: batteryDischargePower,
            chargeSetpoint: parseNumericState(
                payload["number.solarflow_800_pro_input_limit"]?.state,
                0
            ),
            dischargeSetpoint: parseNumericState(
                payload["number.solarflow_800_pro_output_limit"]?.state,
                0
            ),
            chargeMaxPower: chargeMaxPower,
            chargeHardwareMaxPower: chargeHardwareMaxPower
        },
        house: {
            demandPower: stats.currentDemandEstimate ?? stats.defensiveTarget ?? 0,
            demandPowerRaw: stats.currentDemandEstimate ?? stats.defensiveTarget ?? 0,
            demandPowerZeroFallback: stats.currentDemandEstimate ?? stats.defensiveTarget ?? 0
        },
        forecast: {
            solarRemainingWh: 0,
            nextHourWh: 0
        },
        sun: {
            aboveHorizon: true,
            nextRising: null
        },
        inverter: {
            acMode: "",
            inverseMaxPower: 0,
            reachable: "",
            producing: "",
            opendtuStatus: ""
        }
    };
}

function createDerivedFromStats(stats = {}) {
    return {
        demand: {
            current: stats.currentDemandEstimate ?? 0,
            defensiveTarget: stats.defensiveTarget ?? 0
        },
        solar: {
            livePower: stats.solarPower ?? 0,
            averagePower: stats.solarAveragePower ?? stats.solarPower ?? 0
        }
    };
}

function createDemandTimingMeta({
    confidence = 1,
    currentRaw = 0,
    currentEstimate = currentRaw,
    minAgeMs = 0,
    maxAgeMs = 0,
    spreadMs = 0,
    gridIsValid = true,
    gridAgeMs = 0
} = {}) {
    return {
        sensorTiming: {
            thresholds: {
                maxSensorAgeMs: 45000,
                maxSensorSpreadMs: 25000,
                reliableConfidence: 0.7
            },
            demand: {
                confidence,
                currentRaw,
                currentEstimate,
                minAgeMs,
                maxAgeMs,
                spreadMs,
                sensors: {
                    grid: {
                        entityId: "sensor.smartmeter_keller_sml_watt_summe",
                        rawState: null,
                        value: 0,
                        isValid: gridIsValid,
                        ageMs: gridAgeMs
                    }
                }
            }
        }
    };
}

function createNormalizationReading(overrides = {}) {
    return {
        entityId: "sensor.example",
        rawState: "0",
        parsedValue: 0,
        value: 0,
        isValid: true,
        sourceTimestamp: "2026-04-18T11:59:55.000Z",
        sourceTimestampMs: Date.parse("2026-04-18T11:59:55.000Z"),
        sourceAgeMs: 5000,
        sourceTimestampField: "last_updated",
        isStale: false,
        staleAgeThresholdMs: 45000,
        usedLastValid: false,
        usedFallback: false,
        lastValidAgeMs: null,
        ...overrides
    };
}

function createNormalizationMeta({ readings = {}, plausibility = {} } = {}) {
    return {
        normalization: {
            triggerIntervalSeconds: 20,
            retainedReadingMs: 120000,
            readings: {
                gridPower: createNormalizationReading({
                    entityId: "sensor.smartmeter_keller_sml_watt_summe",
                    ...readings.gridPower
                }),
                solarPrimaryPower: createNormalizationReading({
                    entityId: "sensor.wechselrichter_ac_leistung",
                    ...readings.solarPrimaryPower
                }),
                solarSecondaryPower: createNormalizationReading({
                    entityId: "sensor.hoymiles600_power",
                    ...readings.solarSecondaryPower
                }),
                batteryChargePower: createNormalizationReading({
                    entityId: "sensor.solarflow_800_pro_grid_input_power",
                    ...readings.batteryChargePower
                }),
                batteryDischargePower: createNormalizationReading({
                    entityId: "sensor.solarflow_800_pro_output_home_power",
                    ...readings.batteryDischargePower
                })
            },
            houseDemand: {
                power: 0,
                rawPower: 0,
                zeroFallbackPower: 0,
                isClamped: false,
                invalidInputs: [],
                retainedInputs: [],
                staleInputs: [],
                wouldBeNegativeWithZeroFallback: false
            },
            plausibility: {
                isConsistent: true,
                issues: [],
                details: [],
                invalidInputs: [],
                retainedInputs: [],
                staleInputs: [],
                thresholds: {
                    maxSensorAgeMs: 45000,
                    maxSensorSpreadMs: 45000,
                    minimumHouseDemandW: 40,
                    setpointToleranceW: 40
                },
                timing: {
                    minInputAgeMs: 0,
                    maxInputAgeMs: 5000,
                    inputAgeSpreadMs: 5000,
                    exceedsSpreadThreshold: false
                },
                houseDemand: {
                    rawPower: 0,
                    clampedPower: 0
                },
                ...plausibility
            }
        }
    };
}

function executeController({ payload, stats, contextState, now, meta, data, derived } = {}) {
    const effectiveStats = {
        defensiveTarget: 0,
        currentDemandEstimate: 0,
        solarPower: 0,
        solarAveragePower: 0,
        ...stats
    };
    const execution = runFunctionNode(controllerScriptPath, {
        now: now || "2026-04-18T12:00:00.000Z",
        contextState,
        msg: {
            payload,
            data: data || createDataFromPayload(payload, effectiveStats),
            derived: derived || createDerivedFromStats(effectiveStats),
            meta: meta || {}
        }
    });

    if (execution.result === null) {
        return {
            ...execution,
            outputMsg: null,
            insights: null
        };
    }

    const [outputMsg, insights] = execution.result;
    return {
        ...execution,
        outputMsg,
        insights
    };
}

function toPlain(value) {
    return JSON.parse(JSON.stringify(value));
}

test("holds steady on the morning row when demand exceeds small sunrise solar", () => {
    const payload = createPayload({
        gridPower: 73.32,
        solarPrimaryPower: 52.6,
        solarSecondaryPower: 37.2,
        batteryInflow: 0,
        currentSetInflow: 0
    });

    const { result, outputMsg, insights, statuses, contextState } = executeController({
        payload,
        stats: {
            defensiveTarget: 143,
            solarPower: 90,
            solarAveragePower: 90
        },
        contextState: {
            lastCommand: 0
        },
        now: "2026-04-06T07:52:28.585Z"
    });

    assert.equal(result, null);
    assert.equal(outputMsg, null);
    assert.equal(insights, null);
    assert.deepEqual(statuses, [
        {
            fill: "green",
            shape: "ring",
            text: "Stable @ 0W"
        }
    ]);
    assert.equal(contextState.lastCommand, 0);
});

test("charges at battery max on the midday export row after anti-export correction", () => {
    const payload = createPayload({
        gridPower: -190.46,
        solarPrimaryPower: 815.9,
        solarSecondaryPower: 433.4,
        batteryInflow: 799,
        maxChargePower: 1000,
        currentSetInflow: 799
    });

    const { outputMsg, insights, statuses, contextState } = executeController({
        payload,
        stats: {
            defensiveTarget: 240,
            solarPower: 1249,
            solarAveragePower: 1249
        },
        contextState: {
            lastCommand: 0
        },
        now: "2026-04-06T13:30:21.142Z"
    });

    assert.equal(outputMsg.action.charge.commandPower, 1000);
    assert.equal(insights.payload.sensors.grid, -190.46);
    assert.equal(Math.round(contextState.lastCommand), 1000);
    assert.deepEqual(toPlain(insights), {
        payload: {
            timestamp: "2026-04-06T13:30:21.142Z",
            efficiency: {
                gridExport: 190.46,
                isLeaking: true
            },
            calculation: {
                theoreticalSurplus: 1009,
                targetCharge: 1039,
                finalCommand: 1000
            },
            constraints: {
                clamp: "Battery Max",
                rule: "Anti-Export",
                delta: 1000
            },
            sensors: {
                solarLive: 1249,
                solarStable: 1249,
                solarEffective: 1249,
                demand: 240,
                grid: -190.46,
                soc: 64
            }
        }
    });
    assert.deepEqual(statuses, [
        {
            fill: "red",
            shape: "dot",
            text: "Cmd: 1000W | Clamp: Battery Max | Export: -190W"
        }
    ]);
});

test("clamps to the reported 800W battery limit on the 2026-04-06T14:21:43 export spike", () => {
    const payload = createPayload({
        gridPower: -832.16,
        solarPrimaryPower: 646.8,
        solarSecondaryPower: 387.4,
        batteryInflow: 0,
        maxChargePower: 800,
        currentSetInflow: 0
    });

    const { outputMsg, insights, statuses, contextState } = executeController({
        payload,
        stats: {
            defensiveTarget: 202,
            solarPower: 1034,
            solarAveragePower: 1034
        },
        contextState: {
            lastCommand: 0
        },
        now: "2026-04-06T14:21:43.782Z"
    });

    assert.equal(outputMsg.action.charge.commandPower, 800);
    assert.equal(insights.payload.sensors.grid, -832.16);
    assert.equal(Math.round(contextState.lastCommand), 800);
    assert.deepEqual(toPlain(insights), {
        payload: {
            timestamp: "2026-04-06T14:21:43.782Z",
            efficiency: {
                gridExport: 832.16,
                isLeaking: true
            },
            calculation: {
                theoreticalSurplus: 832,
                targetCharge: 1040,
                finalCommand: 800
            },
            constraints: {
                clamp: "Battery Max",
                rule: "Anti-Export",
                delta: 800
            },
            sensors: {
                solarLive: 1034,
                solarStable: 1034,
                solarEffective: 1034,
                demand: 202,
                grid: -832.16,
                soc: 64
            }
        }
    });
    assert.deepEqual(statuses, [
        {
            fill: "red",
            shape: "dot",
            text: "Cmd: 800W | Clamp: Battery Max | Export: -832W"
        }
    ]);
});

test("should honor a 1000W hardware charge limit", () => {
    const payload = createPayload({
        gridPower: -832.16,
        solarPrimaryPower: 646.8,
        solarSecondaryPower: 387.4,
        batteryInflow: 0,
        maxChargePower: 1000,
        currentSetInflow: 0
    });

    const { outputMsg } = executeController({
        payload,
        stats: {
            defensiveTarget: 202,
            solarPower: 1034,
            solarAveragePower: 1034
        },
        contextState: {
            lastCommand: 0
        },
        now: "2026-04-06T14:21:43.782Z"
    });

    assert.equal(outputMsg.action.charge.commandPower, 1000);
});

test("uses the corrected statistical estimates in the stale-snapshot export case instead of the impossible raw balance", () => {
    const payload = createPayload({
        gridPower: -67.01,
        solarPrimaryPower: 439.1,
        solarSecondaryPower: 292.8,
        batteryInflow: 800,
        maxChargePower: 800,
        currentSetInflow: 799
    });

    const { outputMsg, insights, statuses, contextState } = executeController({
        payload,
        stats: {
            defensiveTarget: 138,
            solarPower: 900,
            solarAveragePower: 900
        },
        contextState: {
            lastCommand: 0
        },
        now: "2026-04-05T13:00:23.491Z"
    });

    assert.equal(outputMsg.action.charge.commandPower, 800);
    assert.equal(insights.payload.sensors.grid, -67.01);
    assert.equal(Math.round(contextState.lastCommand), 800);
    assert.deepEqual(toPlain(insights), {
        payload: {
            timestamp: "2026-04-05T13:00:23.491Z",
            efficiency: {
                gridExport: 67.01,
                isLeaking: true
            },
            calculation: {
                theoreticalSurplus: 762,
                targetCharge: 883,
                finalCommand: 800
            },
            constraints: {
                clamp: "Battery Max",
                rule: "Anti-Export",
                delta: 800
            },
            sensors: {
                solarLive: 900,
                solarStable: 900,
                solarEffective: 900,
                demand: 138,
                grid: -67.01,
                soc: 64
            }
        }
    });
    assert.deepEqual(statuses, [
        {
            fill: "red",
            shape: "dot",
            text: "Cmd: 800W | Clamp: Battery Max | Export: -67W"
        }
    ]);
});

test("keeps at least half of solar power as charge command to avoid battery switch cycling", () => {
    const payload = createPayload({
        gridPower: 650,
        solarPrimaryPower: 250,
        solarSecondaryPower: 150,
        batteryInflow: 500,
        maxChargePower: 800,
        currentSetInflow: 500
    });

    const { outputMsg, insights, statuses, contextState } = executeController({
        payload,
        stats: {
            defensiveTarget: 1050,
            solarPower: 400,
            solarAveragePower: 400
        },
        contextState: {
            lastCommand: 0
        },
        now: "2026-04-06T15:05:00.000Z"
    });

    assert.equal(outputMsg.action.charge.commandPower, 200);
    assert.equal(outputMsg.action.charge.commandPower, 200);
    assert.equal(outputMsg.action.charge.ruleApplied, "Solar Floor (Switch Guard)");
    assert.equal(Math.round(contextState.lastCommand), 200);
    assert.deepEqual(toPlain(insights), {
        payload: {
            timestamp: "2026-04-06T15:05:00.000Z",
            efficiency: {
                gridExport: 0,
                isLeaking: false
            },
            calculation: {
                theoreticalSurplus: -650,
                targetCharge: 200,
                finalCommand: 200
            },
            constraints: {
                clamp: "None",
                rule: "Solar Floor (Switch Guard)",
                delta: 200
            },
            sensors: {
                solarLive: 400,
                solarStable: 400,
                solarEffective: 400,
                demand: 1050,
                grid: 650,
                soc: 64
            }
        }
    });
    assert.deepEqual(statuses, [
        {
            fill: "green",
            shape: "dot",
            text: "Cmd: 200W | Clamp: None | Export: 650W"
        }
    ]);
});

test("limits charge increases from export spikes while solar is unstable", () => {
    const payload = createPayload({
        gridPower: -413.95,
        solarPrimaryPower: 520,
        solarSecondaryPower: 224,
        batteryInflow: 579,
        maxChargePower: 1000,
        currentSetInflow: 579,
        soc: 5,
        minSoc: 5
    });

    const { outputMsg, insights, contextState } = executeController({
        payload,
        stats: {
            defensiveTarget: 200,
            currentDemandEstimate: 200,
            solarPower: 744,
            solarAveragePower: 744
        },
        meta: {
            stability: {
                mode: "solar_unstable",
                demand: "stable",
                solar: "unstable"
            }
        },
        contextState: {
            lastCommand: 579
        },
        now: "2026-05-09T11:21:32.000Z"
    });

    assert.equal(outputMsg.action.charge.commandPower, 829);
    assert.equal(outputMsg.action.charge.ruleApplied, "Anti-Export + Solar-Unstable Slew Limit");
    assert.equal(insights.payload.calculation.targetCharge, 1096);
    assert.equal(insights.payload.constraints.rule, "Anti-Export + Solar-Unstable Slew Limit");
    assert.equal(Math.round(contextState.lastCommand), 829);
});

test("limits charge decreases from import spikes while solar is unstable and charging is active", () => {
    const payload = createPayload({
        gridPower: 1069.95,
        solarPrimaryPower: 520,
        solarSecondaryPower: 224,
        batteryInflow: 1000,
        maxChargePower: 1000,
        currentSetInflow: 1000,
        soc: 5,
        minSoc: 5
    });

    const { outputMsg, insights, contextState } = executeController({
        payload,
        stats: {
            defensiveTarget: 1650,
            currentDemandEstimate: 1650,
            solarPower: 744,
            solarAveragePower: 744
        },
        meta: {
            stability: {
                mode: "solar_unstable",
                demand: "stable",
                solar: "unstable"
            }
        },
        contextState: {
            lastCommand: 0
        },
        now: "2026-05-09T11:21:52.000Z"
    });

    assert.equal(outputMsg.action.charge.commandPower, 750);
    assert.equal(outputMsg.action.charge.ruleApplied, "SoC Recovery + Solar-Unstable Slew Limit");
    assert.equal(insights.payload.calculation.targetCharge, 372);
    assert.equal(insights.payload.constraints.rule, "SoC Recovery + Solar-Unstable Slew Limit");
    assert.equal(Math.round(contextState.lastCommand), 750);
});

test("does not stop charging at minimum SoC on a mild import sample after an active setpoint", () => {
    const payload = createPayload({
        gridPower: 52.85,
        solarPrimaryPower: 70,
        solarSecondaryPower: 30,
        batteryInflow: 393,
        maxChargePower: 1000,
        currentSetInflow: 393,
        soc: 5,
        minSoc: 5
    });

    const { outputMsg, insights, contextState } = executeController({
        payload,
        stats: {
            defensiveTarget: 300,
            currentDemandEstimate: 300,
            solarPower: 100,
            solarAveragePower: 100
        },
        contextState: {
            lastCommand: 0
        },
        now: "2026-05-09T11:27:02.000Z"
    });

    assert.equal(outputMsg.action.charge.commandPower, 143);
    assert.equal(outputMsg.action.charge.ruleApplied, "Low-SoC Mild-Import Slew Limit");
    assert.equal(insights.payload.calculation.targetCharge, 0);
    assert.equal(insights.payload.constraints.rule, "Low-SoC Mild-Import Slew Limit");
    assert.equal(Math.round(contextState.lastCommand), 143);
});

test("does not stop charging at minimum SoC when import conflicts with positive solar surplus", () => {
    const payload = createPayload({
        gridPower: 498.71,
        solarPrimaryPower: 360,
        solarSecondaryPower: 200,
        batteryInflow: 700,
        maxChargePower: 1000,
        currentSetInflow: 700,
        soc: 5,
        minSoc: 5
    });

    const { outputMsg, insights, contextState } = executeController({
        payload,
        stats: {
            defensiveTarget: 37,
            currentDemandEstimate: 396,
            solarPower: 560,
            solarAveragePower: 370
        },
        meta: createDemandTimingMeta({
            confidence: 0.2,
            currentRaw: 396,
            currentEstimate: 396,
            maxAgeMs: 20000,
            spreadMs: 20000,
            gridIsValid: true,
            gridAgeMs: 0
        }),
        contextState: {
            lastCommand: 700,
            lastDemandEstimate: 37
        },
        now: "2026-05-09T11:27:36.059Z"
    });

    assert.equal(outputMsg.action.charge.commandPower, 450);
    assert.equal(
        outputMsg.action.charge.ruleApplied,
        "Low-Confidence Grid Steering + Low-SoC Mild-Import Slew Limit"
    );
    assert.equal(insights.payload.calculation.theoreticalSurplus, 400);
    assert.equal(insights.payload.calculation.targetCharge, -18);
    assert.equal(
        insights.payload.constraints.rule,
        "Low-Confidence Grid Steering + Low-SoC Mild-Import Slew Limit"
    );
    assert.equal(Math.round(contextState.lastCommand), 450);
});

test("does not ratchet near-minimum SoC recovery to zero while positive surplus remains", () => {
    const payload = createPayload({
        gridPower: 233.59,
        solarPrimaryPower: 430,
        solarSecondaryPower: 248,
        batteryInflow: 157,
        maxChargePower: 1000,
        currentSetInflow: 157,
        soc: 6,
        minSoc: 5
    });

    const { outputMsg, insights, contextState } = executeController({
        payload,
        stats: {
            defensiveTarget: 295,
            currentDemandEstimate: 595,
            solarPower: 678,
            solarAveragePower: 586
        },
        meta: {
            ...createDemandTimingMeta({
                confidence: 0.2,
                currentRaw: 595,
                currentEstimate: 595,
                maxAgeMs: 20000,
                spreadMs: 20000,
                gridIsValid: true,
                gridAgeMs: 0
            }),
            stability: {
                mode: "solar_unstable",
                demand: "stable",
                solar: "unstable"
            }
        },
        contextState: {
            lastCommand: 157,
            lastDemandEstimate: 247
        },
        now: "2026-05-09T11:34:20.073Z"
    });

    assert.equal(outputMsg.action.charge.commandPower, 157);
    assert.equal(
        outputMsg.action.charge.ruleApplied,
        "Low-Confidence Grid Steering + Solar-Unstable Slew Limit + Low-SoC Mild-Import Slew Limit"
    );
    assert.equal(insights.payload.calculation.theoreticalSurplus, 323);
    assert.equal(insights.payload.calculation.targetCharge, -539);
    assert.equal(
        insights.payload.constraints.rule,
        "Low-Confidence Grid Steering + Solar-Unstable Slew Limit + Low-SoC Mild-Import Slew Limit"
    );
    assert.equal(Math.round(contextState.lastCommand), 157);
});

test("holds the current charge command when the smartmeter is unavailable and only a retained grid value exists", () => {
    const payload = createPayload({
        gridPower: "unavailable",
        solarPrimaryPower: 615.4,
        solarSecondaryPower: 309.6,
        batteryInflow: 800,
        maxChargePower: 1000,
        currentSetInflow: 800
    });

    const { result, outputMsg, insights, statuses, contextState } = executeController({
        payload,
        data: {
            grid: {
                power: 51.45
            },
            solar: {
                primaryPower: 615.4,
                secondaryPower: 309.6,
                totalPower: 925
            },
            battery: {
                soc: 64,
                minSoc: 15,
                socLimit: 100,
                availableWh: 0,
                chargePower: 800,
                dischargePower: 0,
                chargeSetpoint: 800,
                dischargeSetpoint: 0,
                chargeMaxPower: 1000,
                chargeHardwareMaxPower: 1000
            },
            house: {
                demandPower: 176,
                demandPowerRaw: 176,
                demandPowerZeroFallback: 125
            },
            forecast: {
                solarRemainingWh: 0,
                nextHourWh: 0
            },
            sun: {
                aboveHorizon: true,
                nextRising: null
            },
            inverter: {
                acMode: "",
                inverseMaxPower: 0,
                reachable: "",
                producing: "",
                opendtuStatus: ""
            }
        },
        derived: {
            demand: {
                current: 176,
                defensiveTarget: 176
            },
            solar: {
                livePower: 925,
                averagePower: 925
            }
        },
        meta: {
            sensorTiming: {
                thresholds: {
                    maxSensorAgeMs: 45000,
                    maxSensorSpreadMs: 25000,
                    reliableConfidence: 0.7
                },
                demand: {
                    confidence: 0,
                    currentRaw: 176,
                    currentEstimate: 176,
                    minAgeMs: 0,
                    maxAgeMs: 10007,
                    spreadMs: 10007,
                    sensors: {
                        grid: {
                            entityId: "sensor.smartmeter_keller_sml_watt_summe",
                            rawState: "unavailable",
                            value: 0,
                            isValid: false,
                            ageMs: 10007
                        },
                        batteryDischarge: {
                            entityId: "sensor.solarflow_800_pro_output_home_power",
                            rawState: "0",
                            value: 0,
                            isValid: true,
                            ageMs: 0
                        },
                        solarPrimary: {
                            entityId: "sensor.wechselrichter_ac_leistung",
                            rawState: "615.4",
                            value: 615.4,
                            isValid: true,
                            ageMs: 0
                        },
                        solarSecondary: {
                            entityId: "sensor.hoymiles600_power",
                            rawState: "309.6",
                            value: 309.6,
                            isValid: true,
                            ageMs: 0
                        },
                        batteryCharge: {
                            entityId: "sensor.solarflow_800_pro_grid_input_power",
                            rawState: "800",
                            value: 800,
                            isValid: true,
                            ageMs: 0
                        }
                    }
                }
            }
        },
        stats: {
            defensiveTarget: 176,
            currentDemandEstimate: 176,
            solarPower: 925,
            solarAveragePower: 925
        },
        contextState: {
            lastCommand: 800
        },
        now: "2026-04-06T14:47:04.645Z"
    });

    assert.equal(result, null);
    assert.equal(outputMsg, null);
    assert.equal(insights, null);
    assert.equal(contextState.lastCommand, 800);
    assert.deepEqual(statuses, [
        {
            fill: "green",
            shape: "ring",
            text: "Stable @ 800W"
        }
    ]);
});

[
    {
        title: "does not charge at night when statistics reports reliable no-solar demand with discharge covering load",
        payload: createPayload({
            gridPower: 258.43,
            solarPrimaryPower: 0,
            solarSecondaryPower: "unavailable",
            batteryInflow: 0,
            batteryDischargePower: 268,
            currentSetInflow: 0
        }),
        stats: {
            defensiveTarget: 526,
            currentDemandEstimate: 526,
            solarPower: 0,
            solarAveragePower: 0
        },
        meta: createDemandTimingMeta({
            confidence: 1,
            currentRaw: 526,
            currentEstimate: 526
        }),
        contextState: {
            lastCommand: 0
        },
        now: "2026-04-05T22:00:13.490Z"
    },
    {
        title: "does not charge late at night when statistics treats unavailable secondary solar as reliable zero production",
        payload: createPayload({
            gridPower: 54.13,
            solarPrimaryPower: 0,
            solarSecondaryPower: "unavailable",
            batteryInflow: 0,
            batteryDischargePower: 82,
            currentSetInflow: 0
        }),
        stats: {
            defensiveTarget: 136,
            currentDemandEstimate: 136,
            solarPower: 0,
            solarAveragePower: 0
        },
        meta: createDemandTimingMeta({
            confidence: 1,
            currentRaw: 136,
            currentEstimate: 136
        }),
        contextState: {
            lastCommand: 0
        },
        now: "2026-04-06T00:43:40.283Z"
    },
    {
        title: "keeps using measured morning solar even when forecast is optimistic but local shading limits production",
        payload: createPayload({
            gridPower: 73.32,
            solarPrimaryPower: 52.6,
            solarSecondaryPower: 37.2,
            batteryInflow: 0,
            currentSetInflow: 0
        }),
        stats: {
            defensiveTarget: 143,
            currentDemandEstimate: 163,
            solarPower: 90,
            solarAveragePower: 90
        },
        meta: createDemandTimingMeta({
            confidence: 1,
            currentRaw: 163,
            currentEstimate: 163
        }),
        dataOverrides: {
            forecast: {
                nextHourWh: 300,
                solarRemainingWh: 3000
            }
        },
        contextState: {
            lastCommand: 0
        },
        now: "2026-04-06T07:52:28.585Z"
    }
].forEach((scenario) => {
    test(scenario.title, () => {
        const data = createDataFromPayload(scenario.payload, scenario.stats);
        Object.assign(data, scenario.dataOverrides || {});

        const { result, outputMsg, insights, statuses, contextState } = executeController({
            payload: scenario.payload,
            stats: scenario.stats,
            meta: scenario.meta,
            data,
            contextState: scenario.contextState,
            now: scenario.now
        });

        assert.equal(result, null);
        assert.equal(outputMsg, null);
        assert.equal(insights, null);
        assert.equal(contextState.lastCommand, 0);
        assert.deepEqual(statuses, [
            {
                fill: "green",
                shape: "ring",
                text: "Stable @ 0W"
            }
        ]);
    });
});

test("uses low-confidence grid steering when normalized primary solar is stale", () => {
    const payload = createPayload({
        gridPower: 80,
        solarPrimaryPower: 700,
        solarSecondaryPower: 200,
        batteryInflow: 500,
        maxChargePower: 1000,
        currentSetInflow: 500
    });

    const { outputMsg, insights, contextState } = executeController({
        payload,
        stats: {
            defensiveTarget: 300,
            currentDemandEstimate: 300,
            solarPower: 900,
            solarAveragePower: 900
        },
        meta: createNormalizationMeta({
            readings: {
                solarPrimaryPower: {
                    value: 700,
                    sourceAgeMs: 60000,
                    isStale: true
                },
                solarSecondaryPower: {
                    value: 200
                }
            }
        }),
        contextState: {
            lastCommand: 500,
            lastDemandEstimate: 300
        },
        now: "2026-04-18T12:00:00.000Z"
    });

    assert.equal(outputMsg.action.charge.commandPower, 450);
    assert.equal(outputMsg.action.charge.ruleApplied, "Low-Confidence Grid Steering");
    assert.equal(insights.payload.constraints.rule, "Low-Confidence Grid Steering");
    assert.equal(Math.round(contextState.lastCommand), 450);
});

test("uses low-confidence grid steering when normalized secondary solar is retained", () => {
    const payload = createPayload({
        gridPower: -80,
        solarPrimaryPower: 520,
        solarSecondaryPower: 180,
        batteryInflow: 400,
        maxChargePower: 1000,
        currentSetInflow: 400
    });

    const { outputMsg, insights, contextState } = executeController({
        payload,
        stats: {
            defensiveTarget: 300,
            currentDemandEstimate: 300,
            solarPower: 700,
            solarAveragePower: 700
        },
        meta: createNormalizationMeta({
            readings: {
                solarPrimaryPower: {
                    value: 520
                },
                solarSecondaryPower: {
                    value: 180,
                    isValid: false,
                    parsedValue: null,
                    usedLastValid: true,
                    lastValidAgeMs: 30000
                }
            }
        }),
        contextState: {
            lastCommand: 400,
            lastDemandEstimate: 300
        },
        now: "2026-04-18T12:01:00.000Z"
    });

    assert.equal(outputMsg.action.charge.commandPower, 510);
    assert.equal(outputMsg.action.charge.ruleApplied, "Low-Confidence Grid Steering");
    assert.equal(insights.payload.efficiency.isLeaking, true);
    assert.equal(Math.round(contextState.lastCommand), 510);
});

test("uses low-confidence grid steering when normalized demand plausibility is inconsistent", () => {
    const payload = createPayload({
        gridPower: 100,
        solarPrimaryPower: 700,
        solarSecondaryPower: 200,
        batteryInflow: 700,
        maxChargePower: 1000,
        currentSetInflow: 700
    });

    const { outputMsg, insights, contextState } = executeController({
        payload,
        stats: {
            defensiveTarget: 300,
            currentDemandEstimate: 360,
            solarPower: 900,
            solarAveragePower: 900
        },
        meta: createNormalizationMeta({
            plausibility: {
                isConsistent: false,
                issues: ["stale_inputs", "timing_spread"],
                details: ["stale solarSecondaryPower", "age spread 60000ms"],
                staleInputs: ["solarSecondaryPower"],
                timing: {
                    minInputAgeMs: 0,
                    maxInputAgeMs: 60000,
                    inputAgeSpreadMs: 60000,
                    exceedsSpreadThreshold: true
                }
            }
        }),
        contextState: {
            lastCommand: 700,
            lastDemandEstimate: 300
        },
        now: "2026-04-18T12:02:00.000Z"
    });

    assert.equal(outputMsg.action.charge.commandPower, 580);
    assert.equal(outputMsg.action.charge.ruleApplied, "Low-Confidence Grid Steering");
    assert.equal(insights.payload.constraints.rule, "Low-Confidence Grid Steering");
    assert.equal(Math.round(contextState.lastCommand), 580);
});

test("increases charge from a valid export signal when both normalized solar readings are low confidence", () => {
    const payload = createPayload({
        gridPower: -400,
        solarPrimaryPower: 350,
        solarSecondaryPower: 350,
        batteryInflow: 500,
        maxChargePower: 1000,
        currentSetInflow: 500
    });

    const { outputMsg, insights, contextState } = executeController({
        payload,
        stats: {
            defensiveTarget: 300,
            currentDemandEstimate: 300,
            solarPower: 700,
            solarAveragePower: 700
        },
        meta: createNormalizationMeta({
            readings: {
                solarPrimaryPower: {
                    value: 350,
                    isStale: true,
                    sourceAgeMs: 60000
                },
                solarSecondaryPower: {
                    value: 350,
                    isValid: false,
                    parsedValue: null,
                    usedLastValid: true,
                    lastValidAgeMs: 60000
                }
            }
        }),
        contextState: {
            lastCommand: 500,
            lastDemandEstimate: 300
        },
        now: "2026-04-18T12:03:00.000Z"
    });

    assert.equal(outputMsg.action.charge.commandPower, 930);
    assert.equal(outputMsg.action.charge.ruleApplied, "Low-Confidence Grid Steering");
    assert.equal(insights.payload.efficiency.gridExport, 400);
    assert.equal(Math.round(contextState.lastCommand), 930);
});

test("holds charge when normalized primary solar and grid readings are stale", () => {
    const payload = createPayload({
        gridPower: 80,
        solarPrimaryPower: 700,
        solarSecondaryPower: 200,
        batteryInflow: 400,
        maxChargePower: 1000,
        currentSetInflow: 400
    });

    const { result, outputMsg, insights, statuses, contextState } = executeController({
        payload,
        stats: {
            defensiveTarget: 300,
            currentDemandEstimate: 300,
            solarPower: 900,
            solarAveragePower: 900
        },
        meta: createNormalizationMeta({
            readings: {
                gridPower: {
                    value: 80,
                    isStale: true,
                    sourceAgeMs: 30000,
                    staleAgeThresholdMs: 20000
                },
                solarPrimaryPower: {
                    value: 700,
                    isStale: true,
                    sourceAgeMs: 60000
                },
                solarSecondaryPower: {
                    value: 200
                }
            }
        }),
        contextState: {
            lastCommand: 400,
            lastDemandEstimate: 300,
            lastSolarSecondaryPower: 200
        },
        now: "2026-04-18T12:04:00.000Z"
    });

    assert.equal(result, null);
    assert.equal(outputMsg, null);
    assert.equal(insights, null);
    assert.equal(contextState.lastCommand, 400);
    assert.deepEqual(statuses, [
        {
            fill: "green",
            shape: "ring",
            text: "Stable @ 400W"
        }
    ]);
});

test("raises charge from fresh secondary solar increase when normalized grid and primary solar are stale", () => {
    const payload = createPayload({
        gridPower: 80,
        solarPrimaryPower: 700,
        solarSecondaryPower: 400,
        batteryInflow: 400,
        maxChargePower: 1000,
        currentSetInflow: 400
    });

    const { outputMsg, insights, statuses, contextState } = executeController({
        payload,
        stats: {
            defensiveTarget: 300,
            currentDemandEstimate: 300,
            solarPower: 1100,
            solarAveragePower: 900
        },
        meta: createNormalizationMeta({
            readings: {
                gridPower: {
                    value: 80,
                    isStale: true,
                    sourceAgeMs: 30000,
                    staleAgeThresholdMs: 20000
                },
                solarPrimaryPower: {
                    value: 700,
                    isStale: true,
                    sourceAgeMs: 60000
                },
                solarSecondaryPower: {
                    value: 400,
                    sourceAgeMs: 5000
                }
            }
        }),
        contextState: {
            lastCommand: 400,
            lastDemandEstimate: 300,
            lastSolarSecondaryPower: 200
        },
        now: "2026-04-18T12:05:00.000Z"
    });

    assert.equal(outputMsg.action.charge.commandPower, 500);
    assert.equal(outputMsg.action.charge.ruleApplied, "Low-Confidence Solar Increase");
    assert.equal(insights.payload.constraints.rule, "Low-Confidence Solar Increase");
    assert.equal(statuses[0].text, "Cmd: 500W | Rule: Low-Confidence Solar Increase | Grid: stale");
    assert.equal(Math.round(contextState.lastCommand), 500);
    assert.equal(contextState.lastSolarSecondaryPower, 400);
});

test("keeps morning charge modest when forecast rises but measured solar is still weak", () => {
    const payload = createPayload({
        gridPower: 270,
        solarPrimaryPower: 39,
        solarSecondaryPower: 32,
        batteryInflow: 0,
        maxChargePower: 1000,
        currentSetInflow: 0
    });
    const data = createDataFromPayload(payload, {
        defensiveTarget: 56,
        currentDemandEstimate: 56,
        solarPower: 71,
        solarAveragePower: 71
    });
    data.forecast = {
        nextHourWh: 200,
        solarRemainingWh: 2000
    };

    const { outputMsg, insights, contextState } = executeController({
        payload,
        data,
        stats: {
            defensiveTarget: 56,
            currentDemandEstimate: 56,
            solarPower: 71,
            solarAveragePower: 71
        },
        meta: createNormalizationMeta({
            readings: {
                solarPrimaryPower: {
                    value: 39
                },
                solarSecondaryPower: {
                    value: 32
                }
            }
        }),
        contextState: {
            lastCommand: 0
        },
        now: "2026-04-18T09:00:00.000Z"
    });

    assert.equal(outputMsg.action.charge.commandPower, 45);
    assert.equal(outputMsg.action.charge.targetPower, 50);
    assert.equal(insights.payload.sensors.solarLive, 71);
    assert.equal(insights.payload.sensors.solarEffective, 71);
    assert.equal(insights.payload.calculation.theoreticalSurplus, 15);
    assert.equal(Math.round(contextState.lastCommand), 45);
});

[
    {
        title: "increases charge on low confidence when the valid grid signal still shows export",
        payload: createPayload({
            gridPower: -120,
            solarPrimaryPower: 520,
            solarSecondaryPower: 220,
            batteryInflow: 660,
            maxChargePower: 800,
            currentSetInflow: 660
        }),
        stats: {
            defensiveTarget: 0,
            currentDemandEstimate: 0,
            solarPower: 740,
            solarAveragePower: 740
        },
        meta: createDemandTimingMeta({
            confidence: 0.2,
            currentRaw: -40,
            currentEstimate: 0,
            maxAgeMs: 20000,
            spreadMs: 20000,
            gridIsValid: true,
            gridAgeMs: 20000
        }),
        contextState: {
            lastCommand: 660
        },
        now: "2026-04-05T13:05:00.000Z",
        expectedCommand: 660
    },
    {
        title: "increases charge on low confidence when statistics falls back to the last reliable April 6 demand but grid still exports",
        payload: createPayload({
            gridPower: -210.3,
            solarPrimaryPower: 815.9,
            solarSecondaryPower: 431.6,
            batteryInflow: 799,
            maxChargePower: 1000,
            currentSetInflow: 799
        }),
        stats: {
            defensiveTarget: 240,
            currentDemandEstimate: 260,
            solarPower: 1247,
            solarAveragePower: 1247
        },
        meta: createDemandTimingMeta({
            confidence: 0,
            currentRaw: 238,
            currentEstimate: 260,
            maxAgeMs: 60035,
            spreadMs: 60035,
            gridIsValid: true,
            gridAgeMs: 0
        }),
        contextState: {
            lastCommand: 799,
            lastGridPower: -190.46,
            lastDemandEstimate: 260
        },
        now: "2026-04-06T13:31:21.177Z",
        expectedCommand: 1000
    },
    {
        title: "increases charge on low confidence when a stale inverter reading makes raw demand negative but the grid meter is still exporting",
        payload: createPayload({
            gridPower: -67.01,
            solarPrimaryPower: 439.1,
            solarSecondaryPower: 292.8,
            batteryInflow: 800,
            maxChargePower: 1000,
            currentSetInflow: 799
        }),
        stats: {
            defensiveTarget: 158,
            currentDemandEstimate: 160,
            solarPower: 900,
            solarAveragePower: 899
        },
        meta: createDemandTimingMeta({
            confidence: 0,
            currentRaw: -135,
            currentEstimate: 160,
            maxAgeMs: 60000,
            spreadMs: 60000,
            gridIsValid: true,
            gridAgeMs: 0
        }),
        contextState: {
            lastCommand: 799,
            lastGridPower: -10,
            lastDemandEstimate: 160
        },
        now: "2026-04-05T13:00:23.491Z",
        expectedCommand: 896
    },
    {
        title: "wait for further increase in charge on low confidence when the valid grid signal still shows export but Inflow already increased",
        payload: createPayload({
            gridPower: -20,
            solarPrimaryPower: 520,
            solarSecondaryPower: 420,
            batteryInflow: 660,
            maxChargePower: 1000,
            currentSetInflow: 800
        }),
        stats: {
            defensiveTarget: 0,
            currentDemandEstimate: 0,
            solarPower: 940,
            solarAveragePower: 940
        },
        meta: createDemandTimingMeta({
            confidence: 0.2,
            currentRaw: -40,
            currentEstimate: 0,
            maxAgeMs: 20000,
            spreadMs: 20000,
            gridIsValid: true,
            gridAgeMs: 20000
        }),
        contextState: {
            lastCommand: 800
        },
        now: "2026-04-05T13:05:00.000Z",
        expectedCommand: 800
    },
    {
        title: "increases charge on low confidence when the valid grid signal still shows export and more charge power is available",
        payload: createPayload({
            gridPower: -120,
            solarPrimaryPower: 620,
            solarSecondaryPower: 420,
            batteryInflow: 660,
            maxChargePower: 1000,
            currentSetInflow: 660
        }),
        stats: {
            defensiveTarget: 0,
            currentDemandEstimate: 0,
            solarPower: 1040,
            solarAveragePower: 1040
        },
        meta: createDemandTimingMeta({
            confidence: 0.2,
            currentRaw: -40,
            currentEstimate: 0,
            maxAgeMs: 20000,
            spreadMs: 20000,
            gridIsValid: true,
            gridAgeMs: 20000
        }),
        contextState: {
            lastCommand: 660
        },
        now: "2026-04-05T13:05:00.000Z",
        expectedCommand: 810 // 120 + 660 + 30 buffer = 810, but limited by the new maxChargePower of 1000 instead of 800
    },
    {
        title: "nudges charge upward on low confidence when stale secondary solar lags behind live export",
        payload: createPayload({
            gridPower: -30,
            solarPrimaryPower: 520,
            solarSecondaryPower: 180,
            batteryInflow: 690,
            maxChargePower: 1000,
            currentSetInflow: 690
        }),
        stats: {
            defensiveTarget: 0,
            currentDemandEstimate: 0,
            solarPower: 700,
            solarAveragePower: 700
        },
        meta: createDemandTimingMeta({
            confidence: 0.2,
            currentRaw: -20,
            currentEstimate: 0,
            maxAgeMs: 20000,
            spreadMs: 20000,
            gridIsValid: true,
            gridAgeMs: 0
        }),
        contextState: {
            lastCommand: 690
        },
        now: "2026-04-05T13:06:00.000Z",
        expectedCommand: 750
    },
    {
        title: "reduces charge slightly on low confidence when import is already above the buffer",
        payload: createPayload({
            gridPower: 40,
            solarPrimaryPower: 480,
            solarSecondaryPower: 210,
            batteryInflow: 500,
            maxChargePower: 800,
            currentSetInflow: 800
        }),
        stats: {
            defensiveTarget: 210,
            currentDemandEstimate: 230,
            solarPower: 690,
            solarAveragePower: 690
        },
        meta: createDemandTimingMeta({
            confidence: 0.2,
            currentRaw: 230,
            currentEstimate: 230,
            maxAgeMs: 20000,
            spreadMs: 20000,
            gridIsValid: true,
            gridAgeMs: 0
        }),
        contextState: {
            lastCommand: 800
        },
        now: "2026-04-05T13:07:00.000Z",
        expectedCommand: 790
    },
    {
        title: "nudges charge upward on low confidence when grid import dropped below the target buffer",
        payload: createPayload({
            gridPower: 20,
            solarPrimaryPower: 520,
            solarSecondaryPower: 210,
            batteryInflow: 600,
            maxChargePower: 800,
            currentSetInflow: 600
        }),
        stats: {
            defensiveTarget: 140,
            currentDemandEstimate: 140,
            solarPower: 730,
            solarAveragePower: 730
        },
        meta: createDemandTimingMeta({
            confidence: 0.2,
            currentRaw: 220,
            currentEstimate: 220,
            maxAgeMs: 20000,
            spreadMs: 20000,
            gridIsValid: true,
            gridAgeMs: 0
        }),
        contextState: {
            lastCommand: 600,
            lastGridPower: 80,
            lastDemandEstimate: 220
        },
        now: "2026-04-05T13:08:00.000Z",
        expectedCommand: 600
    },
    {
        title: "backs charge down on low confidence when the demand estimate increased since the previous run",
        payload: createPayload({
            gridPower: 120,
            solarPrimaryPower: 480,
            solarSecondaryPower: 180,
            batteryInflow: 700,
            maxChargePower: 800,
            currentSetInflow: 700
        }),
        stats: {
            defensiveTarget: 80,
            currentDemandEstimate: 80,
            solarPower: 660,
            solarAveragePower: 660
        },
        meta: createDemandTimingMeta({
            confidence: 0.2,
            currentRaw: 340,
            currentEstimate: 340,
            maxAgeMs: 20000,
            spreadMs: 20000,
            gridIsValid: true,
            gridAgeMs: 0
        }),
        contextState: {
            lastCommand: 700,
            lastGridPower: 40,
            lastDemandEstimate: 260
        },
        now: "2026-04-05T13:09:00.000Z",
        expectedCommand: 540
    },
    {
        title: "keeps charge steady on low confidence when demand has a short peak but solar stays stable",
        payload: createPayload({
            gridPower: 60,
            solarPrimaryPower: 500,
            solarSecondaryPower: 250,
            batteryInflow: 600,
            maxChargePower: 800,
            currentSetInflow: 600
        }),
        stats: {
            defensiveTarget: 220,
            currentDemandEstimate: 420,
            solarPower: 750,
            solarAveragePower: 750
        },
        meta: createDemandTimingMeta({
            confidence: 0.2,
            currentRaw: 420,
            currentEstimate: 420,
            maxAgeMs: 20000,
            spreadMs: 20000,
            gridIsValid: true,
            gridAgeMs: 0
        }),
        contextState: {
            lastCommand: 600,
            lastGridPower: 30,
            lastDemandEstimate: 220
        },
        now: "2026-04-05T13:10:00.000Z",
        expectedCommand: 600
    },
    {
        title: "keeps charge steady on low confidence when demand has a short fall but solar stays stable",
        payload: createPayload({
            gridPower: -10,
            solarPrimaryPower: 500,
            solarSecondaryPower: 250,
            batteryInflow: 600,
            maxChargePower: 800,
            currentSetInflow: 600
        }),
        stats: {
            defensiveTarget: 220,
            currentDemandEstimate: 120,
            solarPower: 750,
            solarAveragePower: 750
        },
        meta: createDemandTimingMeta({
            confidence: 0.2,
            currentRaw: 420,
            currentEstimate: 420,
            maxAgeMs: 20000,
            spreadMs: 20000,
            gridIsValid: true,
            gridAgeMs: 0
        }),
        contextState: {
            lastCommand: 600,
            lastGridPower: 30,
            lastDemandEstimate: 220
        },
        now: "2026-04-05T13:10:00.000Z",
        expectedCommand: 640
    }
].forEach((scenario) => {
    test(scenario.title, () => {
        const { result, outputMsg, insights, statuses, contextState } = executeController({
            payload: scenario.payload,
            stats: scenario.stats,
            meta: scenario.meta,
            contextState: scenario.contextState,
            now: scenario.now
        });

        if (scenario.expectedHold !== undefined) {
            assert.equal(result, null);
            assert.equal(outputMsg, null);
            assert.equal(insights, null);
            assert.equal(contextState.lastCommand, scenario.expectedHold);
            assert.deepEqual(statuses, [
                {
                    fill: "green",
                    shape: "ring",
                    text: `Stable @ ${scenario.expectedHold}W`
                }
            ]);
            return;
        }

        assert.ok(outputMsg, "expected controller to emit a low-confidence adjusted command");
        assert.ok(insights, "expected controller to emit low-confidence control insights");
        assert.equal(outputMsg.action.charge.commandPower, scenario.expectedCommand);
        assert.equal(outputMsg.action.charge.commandPower, scenario.expectedCommand);
        assert.equal(Math.round(contextState.lastCommand), scenario.expectedCommand);
    });
});
