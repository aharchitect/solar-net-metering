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

function createDataFromPayload(payload, adjustment = {}) {
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
            demandPower: adjustment.currentDemandEstimate ?? adjustment.defensiveTarget ?? 0,
            demandPowerRaw: adjustment.currentDemandEstimate ?? adjustment.defensiveTarget ?? 0,
            demandPowerZeroFallback:
                adjustment.currentDemandEstimate ?? adjustment.defensiveTarget ?? 0
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

function createDerivedFromAdjustment(adjustment = {}) {
    return {
        demand: {
            current: adjustment.currentDemandEstimate ?? 0,
            defensiveTarget: adjustment.defensiveTarget ?? 0
        },
        solar: {
            livePower: adjustment.solarPower ?? 0,
            averagePower: adjustment.solarAveragePower ?? adjustment.solarPower ?? 0
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

function executeController({ payload, adjustment, contextState, now, meta, data, derived } = {}) {
    const effectiveAdjustment = {
        defensiveTarget: 0,
        currentDemandEstimate: 0,
        solarPower: 0,
        solarAveragePower: 0,
        ...adjustment
    };
    const execution = runFunctionNode(controllerScriptPath, {
        now: now || "2026-04-18T12:00:00.000Z",
        contextState,
        msg: {
            payload,
            data: data || createDataFromPayload(payload, effectiveAdjustment),
            derived: derived || createDerivedFromAdjustment(effectiveAdjustment),
            meta: meta || {},
            adjustment: effectiveAdjustment
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
        adjustment: {
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
        adjustment: {
            defensiveTarget: 240,
            solarPower: 1249,
            solarAveragePower: 1249
        },
        contextState: {
            lastCommand: 0
        },
        now: "2026-04-06T13:30:21.142Z"
    });

    assert.equal(outputMsg.adjustment.command, 1000);
    assert.equal(outputMsg.adjustment.grid, -190.46);
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
        adjustment: {
            defensiveTarget: 202,
            solarPower: 1034,
            solarAveragePower: 1034
        },
        contextState: {
            lastCommand: 0
        },
        now: "2026-04-06T14:21:43.782Z"
    });

    assert.equal(outputMsg.adjustment.command, 800);
    assert.equal(outputMsg.adjustment.grid, -832.16);
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
        adjustment: {
            defensiveTarget: 202,
            solarPower: 1034,
            solarAveragePower: 1034
        },
        contextState: {
            lastCommand: 0
        },
        now: "2026-04-06T14:21:43.782Z"
    });

    assert.equal(outputMsg.adjustment.command, 1000);
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
        adjustment: {
            defensiveTarget: 138,
            solarPower: 900,
            solarAveragePower: 900
        },
        contextState: {
            lastCommand: 0
        },
        now: "2026-04-05T13:00:23.491Z"
    });

    assert.equal(outputMsg.adjustment.command, 800);
    assert.equal(outputMsg.adjustment.grid, -67.01);
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
        adjustment: {
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
        adjustment: {
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
        adjustment: {
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
        adjustment: {
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
        const data = createDataFromPayload(scenario.payload, scenario.adjustment);
        Object.assign(data, scenario.dataOverrides || {});

        const { result, outputMsg, insights, statuses, contextState } = executeController({
            payload: scenario.payload,
            adjustment: scenario.adjustment,
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
        adjustment: {
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
        adjustment: {
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
        adjustment: {
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
        adjustment: {
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
        adjustment: {
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
        adjustment: {
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
        adjustment: {
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
        adjustment: {
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
        adjustment: {
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
        adjustment: {
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
        adjustment: {
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
            adjustment: scenario.adjustment,
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
        assert.ok(insights, "expected controller to emit low-confidence adjustment insights");
        assert.equal(outputMsg.adjustment.command, scenario.expectedCommand);
        assert.equal(outputMsg.action.charge.commandPower, scenario.expectedCommand);
        assert.equal(Math.round(contextState.lastCommand), scenario.expectedCommand);
    });
});
