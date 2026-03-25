// Specification:
// Encapsulate Home Assistant entity ids in one place and expose a semantic,
// reusable internal message structure for all subsequent controller nodes.
const ha = msg.payload || {};

function getEntity(entityId) {
    return ha[entityId];
}

function getNumber(entityId, fallback = 0) {
    const value = parseFloat(getEntity(entityId)?.state);
    return Number.isFinite(value) ? value : fallback;
}

function getString(entityId, fallback = "") {
    const value = getEntity(entityId)?.state;
    return value !== undefined && value !== null ? String(value) : fallback;
}

function getAttributeNumber(entityId, attributeName, fallback = 0) {
    const value = parseFloat(getEntity(entityId)?.attributes?.[attributeName]);
    return Number.isFinite(value) ? value : fallback;
}

function getWh(entityId) {
    const entity = getEntity(entityId);
    if (!entity) {
        return 0;
    }

    const value = parseFloat(entity.state) || 0;
    const unit = entity.attributes?.unit_of_measurement;
    return unit === "kWh" ? value * 1000 : value;
}

const gridPower = getNumber("sensor.smartmeter_keller_sml_watt_summe");
const solarPrimaryPower = getNumber("sensor.wechselrichter_ac_leistung");
const solarSecondaryPower = getNumber("sensor.hoymiles600_power");
const batteryChargePower = getNumber("sensor.solarflow_800_pro_grid_input_power");
const batteryDischargePower = getNumber("sensor.solarflow_800_pro_output_home_power");

if (!msg.derived) {
    msg.derived = {};
}
if (!msg.action) {
    msg.action = {};
}
if (!msg.meta) {
    msg.meta = {};
}

msg.data = {
    grid: {
        power: gridPower
    },
    solar: {
        primaryPower: solarPrimaryPower,
        secondaryPower: solarSecondaryPower,
        totalPower: solarPrimaryPower + solarSecondaryPower
    },
    battery: {
        soc: getNumber("sensor.solarflow_800_pro_electric_level"),
        minSoc: getNumber("number.solarflow_800_pro_min_soc", 15),
        socLimit: getNumber("number.solarflow_800_pro_soc_set", 100),
        availableWh: getNumber("sensor.solarflow_800_pro_available_kwh") * 1000,
        chargePower: batteryChargePower,
        dischargePower: batteryDischargePower,
        chargeSetpoint: getNumber("number.solarflow_800_pro_input_limit"),
        dischargeSetpoint: getNumber("number.solarflow_800_pro_output_limit"),
        chargeMaxPower: getNumber("sensor.solarflow_800_pro_charge_max_limit", 800),
        chargeHardwareMaxPower: getAttributeNumber(
            "sensor.solarflow_800_pro_charge_max_limit",
            "max",
            800
        )
    },
    house: {
        demandPower:
            gridPower +
            batteryDischargePower +
            solarPrimaryPower +
            solarSecondaryPower -
            batteryChargePower
    },
    forecast: {
        solarRemainingWh:
            getWh("sensor.energy_production_today_remaining") +
            getWh("sensor.energy_production_today_remaining_2"),
        nextHourWh: getNumber("sensor.energy_next_hour") + getNumber("sensor.energy_next_hour_2")
    },
    sun: {
        aboveHorizon: getString("sun.sun") === "above_horizon",
        nextRising: getEntity("sun.sun")?.attributes?.next_rising || null
    },
    inverter: {
        acMode: getString("select.solarflow_800_pro_ac_mode"),
        inverseMaxPower: getNumber("sensor.solarflow_800_pro_inverse_max_power"),
        reachable: getString("binary_sensor.hoymiles600_reachable"),
        producing: getString("binary_sensor.hoymiles600_producing"),
        opendtuStatus: getString("binary_sensor.opendtu_b69d10_status")
    }
};

msg.meta.source = {
    kind: "home_assistant_map"
};

return msg;
