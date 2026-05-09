const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { runFunctionNode } = require("./helpers/run-function-node");

const normalizeScriptPath = path.join(
    __dirname,
    "..",
    "function-nodes",
    "normalize-home-assistant-data.js"
);

const NOW = "2026-04-06T12:00:00.000Z";

function isoSecondsAgo(secondsAgo) {
    return new Date(Date.parse(NOW) - secondsAgo * 1000).toISOString();
}

function secondsBefore(timestamp, seconds) {
    return new Date(Date.parse(timestamp) - seconds * 1000).toISOString();
}

function entity(state, options = {}) {
    const attributes = options.attributes ? structuredClone(options.attributes) : {};
    return {
        state: state === null || state === undefined ? state : String(state),
        last_updated: options.last_updated || isoSecondsAgo(5),
        attributes
    };
}

function createPayload(overrides = {}) {
    return {
        "sensor.smartmeter_keller_sml_watt_summe": entity(120, { last_updated: isoSecondsAgo(10) }),
        "sensor.wechselrichter_ac_leistung": entity(500, { last_updated: isoSecondsAgo(4) }),
        "sensor.hoymiles600_power": entity(100, { last_updated: isoSecondsAgo(6) }),
        "sensor.solarflow_800_pro_grid_input_power": entity(0, { last_updated: isoSecondsAgo(3) }),
        "sensor.solarflow_800_pro_output_home_power": entity(0, { last_updated: isoSecondsAgo(3) }),
        "sensor.solarflow_800_pro_electric_level": entity(64),
        "number.solarflow_800_pro_min_soc": entity(15),
        "number.solarflow_800_pro_soc_set": entity(100),
        "sensor.solarflow_800_pro_available_kwh": entity(0.55),
        "number.solarflow_800_pro_input_limit": entity(800),
        "number.solarflow_800_pro_output_limit": entity(0),
        "sensor.solarflow_800_pro_charge_max_limit": entity(800, {
            attributes: { max: 800 }
        }),
        "sensor.energy_production_today_remaining": entity(1.2, {
            attributes: { unit_of_measurement: "kWh" }
        }),
        "sensor.energy_production_today_remaining_2": entity(300, {
            attributes: { unit_of_measurement: "Wh" }
        }),
        "sensor.energy_next_hour": entity(0.4, {
            attributes: { unit_of_measurement: "kWh" }
        }),
        "sensor.energy_next_hour_2": entity(100, {
            attributes: { unit_of_measurement: "Wh" }
        }),
        "sun.sun": entity("above_horizon", {
            attributes: { next_rising: "2026-04-07T04:33:00.000Z" }
        }),
        "select.solarflow_800_pro_ac_mode": entity("normal"),
        "sensor.solarflow_800_pro_inverse_max_power": entity(600),
        "binary_sensor.hoymiles600_reachable": entity("on"),
        "binary_sensor.hoymiles600_producing": entity("on"),
        "binary_sensor.opendtu_b69d10_status": entity("on"),
        ...overrides
    };
}

function executeNormalize({ payload = createPayload(), contextState, now = NOW, msg } = {}) {
    const execution = runFunctionNode(normalizeScriptPath, {
        now,
        contextState,
        msg: {
            payload,
            meta: {
                trigger: {
                    intervalSeconds: 10
                }
            },
            ...msg
        }
    });
    const [normalizedMsg, telemetry] = execution.result;

    return {
        ...execution,
        normalizedMsg,
        telemetry
    };
}

function toNativeArray(value) {
    return Array.from(value);
}

function getHouseDemandPlausibility(normalizedMsg) {
    return normalizedMsg.derived.houseDemandPlausibility;
}

function assertIncludesAll(actualValues, expectedValues) {
    const nativeValues = toNativeArray(actualValues);

    expectedValues.forEach((expectedValue) => {
        assert.ok(
            nativeValues.includes(expectedValue),
            `Expected ${JSON.stringify(nativeValues)} to include ${expectedValue}`
        );
    });
}

test("normalizes a daytime happy path with timestamp and age logging", () => {
    const { normalizedMsg, telemetry, statuses, contextState } = executeNormalize();
    const plausibility = getHouseDemandPlausibility(normalizedMsg);

    assert.equal(normalizedMsg.data.grid.power, 120);
    assert.equal(normalizedMsg.data.solar.primaryPower, 500);
    assert.equal(normalizedMsg.data.solar.secondaryPower, 100);
    assert.equal(normalizedMsg.data.solar.totalPower, 600);
    assert.equal(normalizedMsg.data.house.demandPowerRaw, 720);
    assert.equal(normalizedMsg.data.house.demandPower, 720);
    assert.equal(normalizedMsg.data.forecast.solarRemainingWh, 1500);
    assert.equal(normalizedMsg.data.forecast.nextHourWh, 500);
    assert.equal(normalizedMsg.data.sun.aboveHorizon, true);
    assert.equal(
        normalizedMsg.meta.normalization.readings.gridPower.sourceTimestamp,
        isoSecondsAgo(10)
    );
    assert.equal(normalizedMsg.meta.normalization.readings.gridPower.sourceAgeMs, 10000);
    assert.equal(telemetry.payload.gridAgeMs, 10000);
    assert.equal(telemetry.payload.demandPower, 720);
    assert.equal(plausibility.isConsistent, true);
    assert.deepEqual(toNativeArray(plausibility.issues), []);
    assert.equal(telemetry.payload.demandPlausible, true);
    assert.deepEqual(statuses, [{ fill: "green", shape: "dot", text: "Demand 720W" }]);
    assert.equal(
        contextState.lastValidNumbers["sensor.smartmeter_keller_sml_watt_summe"].value,
        120
    );
});

test("normalizes a nighttime happy path without solar production", () => {
    const payload = createPayload({
        "sensor.smartmeter_keller_sml_watt_summe": entity(180, { last_updated: isoSecondsAgo(12) }),
        "sensor.wechselrichter_ac_leistung": entity(0, { last_updated: isoSecondsAgo(45) }),
        "sensor.hoymiles600_power": entity(0, { last_updated: isoSecondsAgo(45) }),
        "sun.sun": entity("below_horizon", {
            attributes: { next_rising: "2026-04-07T04:33:00.000Z" }
        })
    });

    const { normalizedMsg, telemetry, statuses } = executeNormalize({ payload });
    const plausibility = getHouseDemandPlausibility(normalizedMsg);

    assert.equal(normalizedMsg.data.solar.totalPower, 0);
    assert.equal(normalizedMsg.data.house.demandPowerRaw, 180);
    assert.equal(normalizedMsg.data.house.demandPower, 180);
    assert.equal(normalizedMsg.data.sun.aboveHorizon, false);
    assert.equal(normalizedMsg.data.sun.nextRising, "2026-04-07T04:33:00.000Z");
    assert.equal(telemetry.payload.totalSolarPower, 0);
    assert.equal(plausibility.isConsistent, true);
    assert.deepEqual(toNativeArray(plausibility.staleInputs), []);
    assert.equal(telemetry.payload.demandPlausible, true);
    assert.deepEqual(statuses, [{ fill: "green", shape: "dot", text: "Demand 180W" }]);
});

test("normalizes nighttime when both inverter power sensors are unavailable", () => {
    const payload = createPayload({
        "sensor.smartmeter_keller_sml_watt_summe": entity(180, { last_updated: isoSecondsAgo(12) }),
        "sensor.wechselrichter_ac_leistung": entity("unavailable", {
            last_updated: isoSecondsAgo(45)
        }),
        "sensor.hoymiles600_power": entity("unavailable", {
            last_updated: isoSecondsAgo(45)
        }),
        "sun.sun": entity("below_horizon", {
            attributes: { next_rising: "2026-04-07T04:33:00.000Z" }
        })
    });

    const { normalizedMsg, telemetry, statuses } = executeNormalize({ payload });
    const plausibility = getHouseDemandPlausibility(normalizedMsg);

    assert.equal(normalizedMsg.data.solar.primaryPower, 0);
    assert.equal(normalizedMsg.data.solar.secondaryPower, 0);
    assert.equal(normalizedMsg.data.solar.totalPower, 0);
    assert.equal(normalizedMsg.data.house.demandPowerRaw, 180);
    assert.equal(normalizedMsg.data.house.demandPower, 180);
    assert.equal(normalizedMsg.data.sun.aboveHorizon, false);
    assert.deepEqual(toNativeArray(normalizedMsg.meta.normalization.houseDemand.invalidInputs), [
        "solarPrimaryPower",
        "solarSecondaryPower"
    ]);
    assert.equal(plausibility.isConsistent, false);
    assertIncludesAll(plausibility.issues, ["invalid_inputs"]);
    assert.equal(telemetry.payload.solarPrimaryValid, false);
    assert.equal(telemetry.payload.solarSecondaryValid, false);
    assert.equal(telemetry.payload.demandPlausible, false);
    assert.equal(telemetry.payload.totalSolarPower, 0);
    assert.deepEqual(statuses, [
        {
            fill: "yellow",
            shape: "ring",
            text: "Demand 180W | invalid solarPrimaryPower,solarSecondaryPower"
        }
    ]);
});

test("computes house demand directly when battery charging and discharging are both zero", () => {
    const payload = createPayload({
        "sensor.smartmeter_keller_sml_watt_summe": entity(75),
        "sensor.wechselrichter_ac_leistung": entity(320),
        "sensor.hoymiles600_power": entity(55),
        "sensor.solarflow_800_pro_grid_input_power": entity(0),
        "sensor.solarflow_800_pro_output_home_power": entity(0)
    });

    const { normalizedMsg, telemetry } = executeNormalize({ payload });

    assert.equal(normalizedMsg.data.battery.chargePower, 0);
    assert.equal(normalizedMsg.data.battery.dischargePower, 0);
    assert.equal(normalizedMsg.data.house.demandPowerRaw, 450);
    assert.equal(normalizedMsg.meta.normalization.houseDemand.rawPower, 450);
    assert.equal(telemetry.payload.demandPowerRaw, 450);
    assert.equal(telemetry.payload.demandPowerClamped, false);
});

test("reuses the last valid grid value when the current grid reading is unavailable", () => {
    const initialRun = executeNormalize({
        payload: createPayload({
            "sensor.smartmeter_keller_sml_watt_summe": entity(250, {
                last_updated: isoSecondsAgo(8)
            })
        }),
        now: NOW
    });

    const secondRun = executeNormalize({
        payload: createPayload({
            "sensor.smartmeter_keller_sml_watt_summe": entity("unavailable", {
                last_updated: isoSecondsAgo(2)
            })
        }),
        contextState: initialRun.contextState,
        now: "2026-04-06T12:00:30.000Z"
    });

    assert.equal(secondRun.normalizedMsg.data.grid.power, 250);
    assert.equal(secondRun.normalizedMsg.meta.normalization.readings.gridPower.isValid, false);
    assert.equal(secondRun.normalizedMsg.meta.normalization.readings.gridPower.usedLastValid, true);
    assert.equal(
        secondRun.normalizedMsg.meta.normalization.readings.gridPower.lastValidAgeMs,
        30000
    );
    assert.deepEqual(
        toNativeArray(secondRun.normalizedMsg.meta.normalization.houseDemand.invalidInputs),
        ["gridPower"]
    );
    assert.deepEqual(
        toNativeArray(secondRun.normalizedMsg.meta.normalization.houseDemand.retainedInputs),
        ["gridPower"]
    );
    assert.equal(secondRun.normalizedMsg.derived.houseDemandPlausibility.isConsistent, false);
    assertIncludesAll(secondRun.normalizedMsg.derived.houseDemandPlausibility.issues, [
        "invalid_inputs",
        "retained_inputs"
    ]);
    assert.equal(secondRun.telemetry.payload.gridState, "unavailable");
    assert.equal(secondRun.telemetry.payload.gridPower, 250);
    assert.equal(secondRun.telemetry.payload.gridUsedLastValid, true);
    assert.equal(secondRun.telemetry.payload.demandPlausible, false);
    assert.deepEqual(secondRun.statuses, [
        {
            fill: "yellow",
            shape: "ring",
            text: "Demand 850W | invalid gridPower"
        }
    ]);
});

test("clamps negative net house demand while keeping raw telemetry for diagnosis", () => {
    const payload = createPayload({
        "sensor.smartmeter_keller_sml_watt_summe": entity(-67.01, {
            last_updated: "2026-04-05T13:00:23.491Z"
        }),
        "sensor.wechselrichter_ac_leistung": entity(439.1, {
            last_updated: "2026-04-05T12:58:43.491Z"
        }),
        "sensor.hoymiles600_power": entity(292.8, {
            last_updated: "2026-04-05T13:00:23.491Z"
        }),
        "sensor.solarflow_800_pro_grid_input_power": entity(800, {
            last_updated: "2026-04-05T13:00:23.491Z"
        }),
        "sensor.solarflow_800_pro_output_home_power": entity(0, {
            last_updated: "2026-04-05T13:00:23.491Z"
        })
    });

    const { normalizedMsg, telemetry, statuses } = executeNormalize({
        payload,
        now: "2026-04-05T13:00:23.491Z"
    });
    const plausibility = getHouseDemandPlausibility(normalizedMsg);

    assert.ok(Math.abs(normalizedMsg.data.house.demandPowerRaw + 135.11) < 1e-9);
    assert.equal(normalizedMsg.data.house.demandPower, 0);
    assert.ok(Math.abs(normalizedMsg.data.house.demandPowerZeroFallback + 135.11) < 1e-9);
    assert.equal(normalizedMsg.meta.normalization.houseDemand.isClamped, true);
    assert.deepEqual(toNativeArray(normalizedMsg.meta.normalization.houseDemand.invalidInputs), []);
    assert.equal(plausibility.isConsistent, false);
    assertIncludesAll(plausibility.issues, ["stale_inputs", "timing_spread", "negative_demand"]);
    assert.deepEqual(toNativeArray(plausibility.staleInputs), ["solarPrimaryPower"]);
    assert.equal(telemetry.payload.demandPowerRaw, -135);
    assert.equal(telemetry.payload.demandPower, 0);
    assert.equal(telemetry.payload.demandPowerClamped, true);
    assert.equal(telemetry.payload.demandWouldBeNegativeWithZeroFallback, true);
    assert.equal(telemetry.payload.demandPlausible, false);
    assert.equal(telemetry.payload.demandStaleInputs, "solarPrimaryPower");
    assert.deepEqual(statuses, [
        {
            fill: "yellow",
            shape: "ring",
            text: "Demand 0W | stale solarPrimaryPower"
        }
    ]);
});

[
    {
        title: "normalize.data 2026-04-05T12:56:03.317Z keeps a 20s stale solarPrimary value and drops house demand below the 40W baseline",
        now: "2026-04-05T12:56:03.317Z",
        stalePrimaryPower: 525.5,
        gridPower: -16.6,
        secondaryPower: 225.0,
        chargePower: 704,
        expectedRawDemand: 29.9,
        expectedRoundedRawDemand: 30,
        expectedRoundedClampedDemand: 30
    },
    {
        title: "normalize.data 2026-04-05T13:00:23.491Z keeps a 20s stale solarPrimary value and drives house demand negative",
        now: "2026-04-05T13:00:23.491Z",
        stalePrimaryPower: 439.1,
        gridPower: -67.01,
        secondaryPower: 292.8,
        chargePower: 800,
        expectedRawDemand: -135.11,
        expectedRoundedRawDemand: -135,
        expectedRoundedClampedDemand: 0
    },
    {
        title: "normalize.data 2026-04-05T13:15:04.007Z keeps a 20s stale solarPrimary value and produces a strongly negative demand estimate",
        now: "2026-04-05T13:15:04.007Z",
        stalePrimaryPower: 361.9,
        gridPower: -1.7,
        secondaryPower: 199.1,
        chargePower: 705,
        expectedRawDemand: -145.7,
        expectedRoundedRawDemand: -146,
        expectedRoundedClampedDemand: 0
    }
].forEach((scenario) => {
    test(scenario.title, () => {
        const payload = createPayload({
            "sensor.smartmeter_keller_sml_watt_summe": entity(scenario.gridPower, {
                last_updated: scenario.now
            }),
            "sensor.wechselrichter_ac_leistung": entity(scenario.stalePrimaryPower, {
                last_updated: secondsBefore(scenario.now, 20)
            }),
            "sensor.hoymiles600_power": entity(scenario.secondaryPower, {
                last_updated: scenario.now
            }),
            "sensor.solarflow_800_pro_grid_input_power": entity(scenario.chargePower, {
                last_updated: scenario.now
            }),
            "sensor.solarflow_800_pro_output_home_power": entity(0, {
                last_updated: scenario.now
            })
        });

        const { normalizedMsg, telemetry } = executeNormalize({
            payload,
            now: scenario.now
        });
        const plausibility = getHouseDemandPlausibility(normalizedMsg);

        assert.equal(
            normalizedMsg.meta.normalization.readings.solarPrimaryPower.sourceAgeMs,
            20000
        );
        assert.equal(
            normalizedMsg.meta.normalization.readings.solarPrimaryPower.usedLastValid,
            false
        );
        assert.equal(normalizedMsg.meta.normalization.readings.solarPrimaryPower.isValid, true);
        assert.deepEqual(
            toNativeArray(normalizedMsg.meta.normalization.houseDemand.invalidInputs),
            []
        );
        assert.deepEqual(
            toNativeArray(normalizedMsg.meta.normalization.houseDemand.retainedInputs),
            []
        );
        assert.equal(plausibility.isConsistent, false);
        assertIncludesAll(plausibility.issues, ["stale_inputs", "timing_spread"]);
        assert.deepEqual(toNativeArray(plausibility.staleInputs), ["solarPrimaryPower"]);
        assert.equal(telemetry.payload.solarPrimaryAgeMs, 20000);
        assert.equal(telemetry.payload.demandPlausible, false);
        assert.equal(telemetry.payload.demandStaleInputs, "solarPrimaryPower");
        assert.ok(
            Math.abs(
                normalizedMsg.meta.normalization.houseDemand.rawPower - scenario.expectedRawDemand
            ) < 1e-9
        );
        assert.equal(telemetry.payload.demandPowerRaw, scenario.expectedRoundedRawDemand);
        assert.equal(telemetry.payload.demandPower, scenario.expectedRoundedClampedDemand);

        if (scenario.expectedRoundedRawDemand < 0) {
            assert.equal(normalizedMsg.data.house.demandPower, 0);
            assert.equal(normalizedMsg.meta.normalization.houseDemand.isClamped, true);
            assert.equal(telemetry.payload.demandPowerClamped, true);
            assertIncludesAll(plausibility.issues, ["negative_demand"]);
        } else {
            assert.ok(
                Math.abs(normalizedMsg.data.house.demandPower - scenario.expectedRawDemand) < 1e-9
            );
            assert.ok(normalizedMsg.data.house.demandPowerRaw < 40);
            assert.equal(normalizedMsg.meta.normalization.houseDemand.isClamped, false);
            assert.equal(telemetry.payload.demandPowerClamped, false);
            assertIncludesAll(plausibility.issues, ["below_minimum_house_demand"]);
        }
    });
});

[
    {
        title: "a 20s stale grid reading can drive daytime demand negative even while all other inputs are fresh",
        now: "2026-04-05T13:05:00.000Z",
        staleField: "gridPower",
        payloadOverrides: {
            "sensor.smartmeter_keller_sml_watt_summe": entity(-120, {
                last_updated: secondsBefore("2026-04-05T13:05:00.000Z", 20)
            }),
            "sensor.wechselrichter_ac_leistung": entity(520, {
                last_updated: "2026-04-05T13:05:00.000Z"
            }),
            "sensor.hoymiles600_power": entity(220, {
                last_updated: "2026-04-05T13:05:00.000Z"
            }),
            "sensor.solarflow_800_pro_grid_input_power": entity(660, {
                last_updated: "2026-04-05T13:05:00.000Z"
            }),
            "sensor.solarflow_800_pro_output_home_power": entity(0, {
                last_updated: "2026-04-05T13:05:00.000Z"
            })
        },
        expectedRawDemand: -40,
        expectedTelemetryDemand: -40,
        expectedClampedDemand: 0
    },
    {
        title: "a 20s stale secondary solar reading can push daytime demand below the physical house baseline",
        now: "2026-04-05T13:06:00.000Z",
        staleField: "solarSecondaryPower",
        payloadOverrides: {
            "sensor.smartmeter_keller_sml_watt_summe": entity(-30, {
                last_updated: "2026-04-05T13:06:00.000Z"
            }),
            "sensor.wechselrichter_ac_leistung": entity(520, {
                last_updated: "2026-04-05T13:06:00.000Z"
            }),
            "sensor.hoymiles600_power": entity(180, {
                last_updated: secondsBefore("2026-04-05T13:06:00.000Z", 20)
            }),
            "sensor.solarflow_800_pro_grid_input_power": entity(690, {
                last_updated: "2026-04-05T13:06:00.000Z"
            }),
            "sensor.solarflow_800_pro_output_home_power": entity(0, {
                last_updated: "2026-04-05T13:06:00.000Z"
            })
        },
        expectedRawDemand: -20,
        expectedTelemetryDemand: -20,
        expectedClampedDemand: 0
    },
    {
        title: "a 20s stale charge-power reading can make daytime demand look strongly positive even though charging already increased",
        now: "2026-04-05T13:07:00.000Z",
        staleField: "batteryChargePower",
        payloadOverrides: {
            "sensor.smartmeter_keller_sml_watt_summe": entity(40, {
                last_updated: "2026-04-05T13:07:00.000Z"
            }),
            "sensor.wechselrichter_ac_leistung": entity(480, {
                last_updated: "2026-04-05T13:07:00.000Z"
            }),
            "sensor.hoymiles600_power": entity(210, {
                last_updated: "2026-04-05T13:07:00.000Z"
            }),
            "sensor.solarflow_800_pro_grid_input_power": entity(500, {
                last_updated: secondsBefore("2026-04-05T13:07:00.000Z", 20)
            }),
            "sensor.solarflow_800_pro_output_home_power": entity(0, {
                last_updated: "2026-04-05T13:07:00.000Z"
            }),
            "number.solarflow_800_pro_input_limit": entity(800, {
                last_updated: "2026-04-05T13:07:00.000Z"
            })
        },
        expectedRawDemand: 230,
        expectedTelemetryDemand: 230,
        expectedClampedDemand: 230
    }
].forEach((scenario) => {
    test(scenario.title, () => {
        const payload = createPayload(scenario.payloadOverrides);
        const { normalizedMsg, telemetry } = executeNormalize({
            payload,
            now: scenario.now
        });
        const plausibility = getHouseDemandPlausibility(normalizedMsg);

        const reading = normalizedMsg.meta.normalization.readings[scenario.staleField];
        assert.equal(reading.sourceAgeMs, 20000);
        assert.equal(reading.usedLastValid, false);
        assert.equal(reading.isValid, true);
        assert.deepEqual(
            toNativeArray(normalizedMsg.meta.normalization.houseDemand.invalidInputs),
            []
        );
        assert.deepEqual(
            toNativeArray(normalizedMsg.meta.normalization.houseDemand.retainedInputs),
            []
        );
        assert.equal(plausibility.isConsistent, false);
        assertIncludesAll(plausibility.issues, ["stale_inputs", "timing_spread"]);
        assert.deepEqual(toNativeArray(plausibility.staleInputs), [scenario.staleField]);
        assert.ok(
            Math.abs(
                normalizedMsg.meta.normalization.houseDemand.rawPower - scenario.expectedRawDemand
            ) < 1e-9
        );
        assert.equal(telemetry.payload.demandPowerRaw, scenario.expectedTelemetryDemand);
        assert.equal(normalizedMsg.data.house.demandPower, scenario.expectedClampedDemand);
        assert.equal(telemetry.payload.demandPlausible, false);

        if (scenario.expectedRawDemand <= 0) {
            assert.equal(normalizedMsg.meta.normalization.houseDemand.isClamped, true);
            assert.equal(telemetry.payload.demandPowerClamped, true);
        } else {
            assert.equal(normalizedMsg.meta.normalization.houseDemand.isClamped, false);
            assert.equal(telemetry.payload.demandPowerClamped, false);
            if (scenario.staleField === "batteryChargePower") {
                assertIncludesAll(plausibility.issues, ["charge_setpoint_mismatch"]);
                assert.equal(telemetry.payload.demandChargeSetpointMismatch, true);
            }
        }
    });
});

test("at night a 20s stale grid reading together with fresh high discharge overstates house demand", () => {
    const now = "2026-04-05T22:10:00.000Z";
    const payload = createPayload({
        "sensor.smartmeter_keller_sml_watt_summe": entity(150, {
            last_updated: secondsBefore(now, 20)
        }),
        "sensor.wechselrichter_ac_leistung": entity(0, {
            last_updated: now
        }),
        "sensor.hoymiles600_power": entity(0, {
            last_updated: now
        }),
        "sensor.solarflow_800_pro_grid_input_power": entity(0, {
            last_updated: now
        }),
        "sensor.solarflow_800_pro_output_home_power": entity(220, {
            last_updated: now
        }),
        "number.solarflow_800_pro_output_limit": entity(300, {
            last_updated: now
        }),
        "sun.sun": entity("below_horizon", {
            attributes: { next_rising: "2026-04-06T04:35:00.000Z" }
        })
    });

    const { normalizedMsg, telemetry } = executeNormalize({ payload, now });
    const plausibility = getHouseDemandPlausibility(normalizedMsg);

    assert.equal(normalizedMsg.data.sun.aboveHorizon, false);
    assert.equal(normalizedMsg.meta.normalization.readings.gridPower.sourceAgeMs, 20000);
    assert.equal(normalizedMsg.meta.normalization.readings.gridPower.isValid, true);
    assert.equal(normalizedMsg.data.battery.dischargePower, 220);
    assert.equal(normalizedMsg.data.battery.dischargeSetpoint, 300);
    assert.equal(normalizedMsg.data.house.demandPowerRaw, 370);
    assert.equal(normalizedMsg.data.house.demandPower, 370);
    assert.deepEqual(toNativeArray(normalizedMsg.meta.normalization.houseDemand.invalidInputs), []);
    assert.equal(plausibility.isConsistent, false);
    assertIncludesAll(plausibility.issues, ["stale_inputs", "timing_spread"]);
    assert.deepEqual(toNativeArray(plausibility.staleInputs), ["gridPower"]);
    assert.equal(telemetry.payload.gridAgeMs, 20000);
    assert.equal(telemetry.payload.demandPowerRaw, 370);
    assert.equal(telemetry.payload.demandPowerClamped, false);
    assert.equal(telemetry.payload.demandPlausible, false);
});

test("at night a stale discharge reading can hide an increasing discharge setpoint and collapse demand toward zero", () => {
    const now = "2026-04-05T22:11:00.000Z";
    const payload = createPayload({
        "sensor.smartmeter_keller_sml_watt_summe": entity(-40, {
            last_updated: now
        }),
        "sensor.wechselrichter_ac_leistung": entity(0, {
            last_updated: now
        }),
        "sensor.hoymiles600_power": entity(0, {
            last_updated: now
        }),
        "sensor.solarflow_800_pro_grid_input_power": entity(0, {
            last_updated: now
        }),
        "sensor.solarflow_800_pro_output_home_power": entity(20, {
            last_updated: secondsBefore(now, 20)
        }),
        "number.solarflow_800_pro_output_limit": entity(350, {
            last_updated: now
        }),
        "sun.sun": entity("below_horizon", {
            attributes: { next_rising: "2026-04-06T04:35:00.000Z" }
        })
    });

    const { normalizedMsg, telemetry } = executeNormalize({ payload, now });
    const plausibility = getHouseDemandPlausibility(normalizedMsg);

    assert.equal(normalizedMsg.data.sun.aboveHorizon, false);
    assert.equal(
        normalizedMsg.meta.normalization.readings.batteryDischargePower.sourceAgeMs,
        20000
    );
    assert.equal(normalizedMsg.meta.normalization.readings.batteryDischargePower.isValid, true);
    assert.equal(normalizedMsg.data.battery.dischargePower, 20);
    assert.equal(normalizedMsg.data.battery.dischargeSetpoint, 350);
    assert.equal(normalizedMsg.data.house.demandPowerRaw, -20);
    assert.equal(normalizedMsg.data.house.demandPower, 0);
    assert.deepEqual(toNativeArray(normalizedMsg.meta.normalization.houseDemand.invalidInputs), []);
    assert.equal(plausibility.isConsistent, false);
    assertIncludesAll(plausibility.issues, [
        "stale_inputs",
        "timing_spread",
        "negative_demand",
        "discharge_setpoint_mismatch"
    ]);
    assert.deepEqual(toNativeArray(plausibility.staleInputs), ["batteryDischargePower"]);
    assert.equal(telemetry.payload.batteryDischargeAgeMs, 20000);
    assert.equal(telemetry.payload.demandPowerRaw, -20);
    assert.equal(telemetry.payload.demandPowerClamped, true);
    assert.equal(telemetry.payload.demandDischargeSetpointMismatch, true);
    assert.equal(telemetry.payload.demandPlausible, false);
});

test("falls back safely when Home Assistant does not respond at all", () => {
    const { normalizedMsg, telemetry, statuses } = executeNormalize({
        payload: null
    });
    const plausibility = getHouseDemandPlausibility(normalizedMsg);

    assert.equal(normalizedMsg.data.grid.power, 0);
    assert.equal(normalizedMsg.data.solar.totalPower, 0);
    assert.equal(normalizedMsg.data.battery.chargePower, 0);
    assert.equal(normalizedMsg.data.battery.dischargePower, 0);
    assert.equal(normalizedMsg.data.house.demandPower, 0);
    assert.equal(normalizedMsg.data.sun.aboveHorizon, false);
    assert.equal(normalizedMsg.data.sun.nextRising, null);
    assert.deepEqual(toNativeArray(normalizedMsg.meta.normalization.houseDemand.invalidInputs), [
        "gridPower",
        "batteryDischargePower",
        "solarPrimaryPower",
        "solarSecondaryPower",
        "batteryChargePower"
    ]);
    assert.equal(plausibility.isConsistent, false);
    assertIncludesAll(plausibility.issues, ["invalid_inputs", "below_minimum_house_demand"]);
    assert.equal(telemetry.payload.gridValid, false);
    assert.equal(telemetry.payload.solarPrimaryValid, false);
    assert.equal(telemetry.payload.batteryChargeValid, false);
    assert.equal(telemetry.payload.demandPlausible, false);
    assert.deepEqual(statuses, [
        {
            fill: "yellow",
            shape: "ring",
            text: "Demand 0W | invalid gridPower,batteryDischargePower,solarPrimaryPower,solarSecondaryPower,batteryChargePower"
        }
    ]);
});
