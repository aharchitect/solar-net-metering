function getFirstFinite(values, fallback = 0) {
    for (const value of values) {
        if (Number.isFinite(value)) {
            return value;
        }
    }

    return fallback;
}

const data = msg.data || {};
const derived = msg.derived || {};

const sunAbove = data.sun?.aboveHorizon === true;
const soc = getFirstFinite([data.battery?.soc], 0);
const minimalCharge = getFirstFinite([data.battery?.minSoc], 0);
const totalSolarRemaining = getFirstFinite([data.forecast?.solarRemainingWh], 0);
const nextHourSolar = getFirstFinite([data.forecast?.nextHourWh], 0);
const solarPower = getFirstFinite([derived.solar?.livePower], 0);
const demandPower = getFirstFinite([derived.demand?.defensiveTarget, derived.demand?.current], 0);

let toCharge = null;
let toDischarge = null;

/**
 * DECISION LOGIC:
 * Switch to NIGHT/DISCHARGE mode only if:
 * - Sun is down OR the total remaining forecast is negligible (< 50Wh)
 * - AND we aren't in a "Low Battery" state where we should strictly wait for sun.
 */
const batteryHasReserve = soc > minimalCharge;
const batteryHasMorningReserve = soc >= minimalCharge + 30;
const lowSocWithoutUsableNearTermSolar = !batteryHasReserve && nextHourSolar < 50;
const isSolarDayOver = !sunAbove || totalSolarRemaining < 50 || lowSocWithoutUsableNearTermSolar;
const nightLowSocBlock = isSolarDayOver && !batteryHasReserve;
const weakMorningSolar =
    sunAbove && batteryHasMorningReserve && solarPower > 50 && solarPower < demandPower;

msg.action = msg.action || {};
msg.action.decision = {
    isSolarDayOver,
    batteryHasReserve,
    nightLowSocBlock,
    dischargeStopThreshold: minimalCharge
};
msg.action.battery = msg.action.battery || {};
msg.action.battery.discharge = msg.action.battery.discharge || {};
msg.action.battery.discharge.stopRequested = nightLowSocBlock;
msg.action.battery.discharge.blockedByLowSoc = nightLowSocBlock;

if (nightLowSocBlock) {
    node.status({
        fill: "red",
        shape: "dot",
        text: `Empty Battery, no solar power: ${solarPower}W, solar forecast ${totalSolarRemaining}Wh, battery soc: ${soc}`
    });
} else if (isSolarDayOver && batteryHasReserve) {
    toDischarge = msg;
    node.status({
        fill: "blue",
        shape: "dot",
        text: `Discharge - Night, remaing solar ${totalSolarRemaining}Wh, Solar Day is Over: ${isSolarDayOver}, battery has res: ${batteryHasReserve}`
    });
} else if (weakMorningSolar) {
    toDischarge = msg;
    node.status({
        fill: "blue",
        shape: "dot",
        text: `Discharge - Weak morning solar, solar ${solarPower}W, demand ${demandPower}W, battery soc: ${soc}`
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
