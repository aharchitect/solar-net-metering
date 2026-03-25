const data = msg.data || {};

// 1. DYNAMIC SUN LOGIC
// Sun state: 'above_horizon' or 'below_horizon'
const sunAbove = data.sun?.aboveHorizon;

// 2. Soc of Battery in %
const soc = data.battery?.soc || 0;
const minimalCharge = data.battery?.minSoc || 0;

// 2. FORECAST LOGIC (Total Energy Remaining)
// Wh remaining today
const totalSolarRemaining = data.forecast?.solarRemainingWh || 0;

// 3. THE DECISION (The "Intelligent" Branch)
let toCharge = null;
let toDischarge = null;

/**
 * DECISION LOGIC:
 * Switch to NIGHT/DISCHARGE mode only if:
 * - Sun is down OR the total remaining forecast is negligible (< 50Wh)
 * - AND we aren't in a "Low Battery" state where we should strictly wait for sun.
 */
const isSolarDayOver = !sunAbove || totalSolarRemaining < 50;
const batteryHasReserve = soc > minimalCharge; // Don't start discharging if battery is nearly empty
msg.action = msg.action || {};
msg.action.decision = {
    isSolarDayOver,
    batteryHasReserve
};
const solarPower = msg.derived.solar?.livePower || 0;

if (isSolarDayOver && batteryHasReserve) {
    toDischarge = msg;
    node.status({
        fill: "blue",
        shape: "dot",
        text: `Discharge - Night, remaing solar ${totalSolarRemaining}Wh, Solar Day is Over: ${isSolarDayOver}, battery has res: ${batteryHasReserve}`
    });
} else if (solarPower > 0) {
    toCharge = msg;
    node.status({
        fill: "yellow",
        shape: "dot",
        text: `Charge - Day/Solar: remaing solar ${totalSolarRemaining}Wh`
    });
} else {
    node.status({
        fill: "red",
        shape: "dot",
        text: `Empty Battery, no solar power: ${solarPower}W, solar forecast ${totalSolarRemaining}Wh, battery soc: ${soc}`
    });
}

return [toCharge, toDischarge];
