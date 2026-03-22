const map = msg.payload;
const adj = msg.adjustment;

// UNIT-AWARE FORECAST (Scaling kWh to Wh)
function getWh(entityId) {
    const entity = map[entityId];
    if (!entity) return 0;

    let value = parseFloat(entity.state) || 0;
    const unit = entity.attributes?.unit_of_measurement;

    // If the unit is kWh, multiply by 1000
    if (unit === "kWh") {
        return value * 1000;
    }
    return value; // Assume Wh otherwise
}

// 1. DYNAMIC SUN LOGIC
// Sun state: 'above_horizon' or 'below_horizon'
const sunAbove = map["sun.sun"]?.state === "above_horizon";

// 2. Soc of Battery in %
const soc = parseFloat(map["sensor.solarflow_800_pro_electric_level"]?.state) || 0;
const minimalCharge = parseFloat(map["number.solarflow_800_pro_min_soc"]?.state) || 0;

// 2. FORECAST LOGIC (Total Energy Remaining)
// Wh remaining today 
const totalSolarRemaining = getWh("sensor.energy_production_today_remaining") +
                            getWh("sensor.energy_production_today_remaining_2");

// 3. THE DECISION (The "Intelligent" Branch)
let toCharge = null;
let toDischarge = null;

/**
 * DECISION LOGIC:
 * Switch to NIGHT/DISCHARGE mode only if:
 * - Sun is down OR the total remaining forecast is negligible (< 50Wh)
 * - AND we aren't in a "Low Battery" state where we should strictly wait for sun.
 */
const isSolarDayOver = !sunAbove || (totalSolarRemaining < 50);
const batteryHasReserve = soc > minimalCharge; // Don't start discharging if battery is nearly empty

if (isSolarDayOver && batteryHasReserve) {
    toDischarge = msg;
    node.status({ fill: "blue", shape: "dot", text: `Discharge - Night, remaing solar ${totalSolarRemaining}Wh, Solar Day is Over: ${isSolarDayOver}, battery has res: ${batteryHasReserve}` });
} else if (adj.solarPower > 0) {
    toCharge = msg;
    node.status({ fill: "yellow", shape: "dot", text: `Charge - Day/Solar: remaing solar ${totalSolarRemaining}Wh` });
} else {
    node.status({ fill: "red", shape: "dot", text: `Empty Battery, no solar power: ${adj.solarPower}W, solar forecast ${totalSolarRemaining}Wh, battery soc: ${soc}` });
}


return [toCharge, toDischarge];
