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

test("normalizes a daytime happy path with timestamp and age logging", () => {
    const { normalizedMsg, telemetry, statuses, contextState } = executeNormalize();

    assert.equal(normalizedMsg.data.grid.power, 120);
    assert.equal(normalizedMsg.data.solar.primaryPower, 500);
    assert.equal(normalizedMsg.data.solar.secondaryPower, 100);
    assert.equal(normalizedMsg.data.solar.totalPower, 600);
    assert.equal(normalizedMsg.data.house.demandPowerRaw, 720);
    assert.equal(normalizedMsg.data.house.demandPower, 720);
    assert.equal(normalizedMsg.data.forecast.solarRemainingWh, 1500);
    assert.equal(normalizedMsg.data.forecast.nextHourWh, 100.4);
    assert.equal(normalizedMsg.data.sun.aboveHorizon, true);
    assert.equal(
        normalizedMsg.meta.normalization.readings.gridPower.sourceTimestamp,
        isoSecondsAgo(10)
    );
    assert.equal(normalizedMsg.meta.normalization.readings.gridPower.sourceAgeMs, 10000);
    assert.equal(telemetry.payload.gridAgeMs, 10000);
    assert.equal(telemetry.payload.demandPower, 720);
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

    assert.equal(normalizedMsg.data.solar.totalPower, 0);
    assert.equal(normalizedMsg.data.house.demandPowerRaw, 180);
    assert.equal(normalizedMsg.data.house.demandPower, 180);
    assert.equal(normalizedMsg.data.sun.aboveHorizon, false);
    assert.equal(normalizedMsg.data.sun.nextRising, "2026-04-07T04:33:00.000Z");
    assert.equal(telemetry.payload.totalSolarPower, 0);
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

    assert.equal(normalizedMsg.data.solar.primaryPower, 0);
    assert.equal(normalizedMsg.data.solar.secondaryPower, 0);
    assert.equal(normalizedMsg.data.solar.totalPower, 0);
    assert.equal(normalizedMsg.data.house.demandPowerRaw, 180);
    assert.equal(normalizedMsg.data.house.demandPower, 180);
    assert.equal(normalizedMsg.data.sun.aboveHorizon, false);
    assert.deepEqual(Array.from(normalizedMsg.meta.normalization.houseDemand.invalidInputs), [
        "solarPrimaryPower",
        "solarSecondaryPower"
    ]);
    assert.equal(telemetry.payload.solarPrimaryValid, false);
    assert.equal(telemetry.payload.solarSecondaryValid, false);
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
        Array.from(secondRun.normalizedMsg.meta.normalization.houseDemand.invalidInputs),
        ["gridPower"]
    );
    assert.deepEqual(
        Array.from(secondRun.normalizedMsg.meta.normalization.houseDemand.retainedInputs),
        ["gridPower"]
    );
    assert.equal(secondRun.telemetry.payload.gridState, "unavailable");
    assert.equal(secondRun.telemetry.payload.gridPower, 250);
    assert.equal(secondRun.telemetry.payload.gridUsedLastValid, true);
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

    assert.ok(Math.abs(normalizedMsg.data.house.demandPowerRaw + 135.11) < 1e-9);
    assert.equal(normalizedMsg.data.house.demandPower, 0);
    assert.ok(Math.abs(normalizedMsg.data.house.demandPowerZeroFallback + 135.11) < 1e-9);
    assert.equal(normalizedMsg.meta.normalization.houseDemand.isClamped, true);
    assert.deepEqual(Array.from(normalizedMsg.meta.normalization.houseDemand.invalidInputs), []);
    assert.equal(telemetry.payload.demandPowerRaw, -135);
    assert.equal(telemetry.payload.demandPower, 0);
    assert.equal(telemetry.payload.demandPowerClamped, true);
    assert.equal(telemetry.payload.demandWouldBeNegativeWithZeroFallback, true);
    assert.deepEqual(statuses, [
        {
            fill: "yellow",
            shape: "ring",
            text: "Demand 0W | negative demand clamped"
        }
    ]);
});

test("falls back safely when Home Assistant does not respond at all", () => {
    const { normalizedMsg, telemetry, statuses } = executeNormalize({
        payload: null
    });

    assert.equal(normalizedMsg.data.grid.power, 0);
    assert.equal(normalizedMsg.data.solar.totalPower, 0);
    assert.equal(normalizedMsg.data.battery.chargePower, 0);
    assert.equal(normalizedMsg.data.battery.dischargePower, 0);
    assert.equal(normalizedMsg.data.house.demandPower, 0);
    assert.equal(normalizedMsg.data.sun.aboveHorizon, false);
    assert.equal(normalizedMsg.data.sun.nextRising, null);
    assert.deepEqual(Array.from(normalizedMsg.meta.normalization.houseDemand.invalidInputs), [
        "gridPower",
        "batteryDischargePower",
        "solarPrimaryPower",
        "solarSecondaryPower",
        "batteryChargePower"
    ]);
    assert.equal(telemetry.payload.gridValid, false);
    assert.equal(telemetry.payload.solarPrimaryValid, false);
    assert.equal(telemetry.payload.batteryChargeValid, false);
    assert.deepEqual(statuses, [
        {
            fill: "yellow",
            shape: "ring",
            text: "Demand 0W | invalid gridPower,batteryDischargePower,solarPrimaryPower,solarSecondaryPower,batteryChargePower"
        }
    ]);
});
