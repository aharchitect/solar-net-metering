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
