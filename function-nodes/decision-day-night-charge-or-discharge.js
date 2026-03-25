function hasMessageValue(root, path) {
    let current = root;
    for (const segment of path.split(".")) {
        if (
            current === null ||
            current === undefined ||
            !Object.prototype.hasOwnProperty.call(current, segment)
        ) {
            return false;
        }
        current = current[segment];
    }
    return current !== undefined;
}

function abortForMissing(requiredPaths) {
    const missing = requiredPaths.filter((path) => !hasMessageValue(msg, path));
    if (missing.length === 0) {
        return false;
    }

    const errorMessage = `Missing mandatory message fields: ${missing.join(", ")}`;
    node.status({ fill: "red", shape: "ring", text: `Missing data: ${missing.join(", ")}` });
    node.error(errorMessage, msg);
    return true;
}

if (
    abortForMissing([
        "data.sun.aboveHorizon",
        "data.battery.soc",
        "data.battery.minSoc",
        "data.forecast.solarRemainingWh",
        "derived.solar.livePower"
    ])
) {
    return null;
}

const data = msg.data;
const derived = msg.derived;

// 1. DYNAMIC SUN LOGIC
// Sun state: 'above_horizon' or 'below_horizon'
const sunAbove = data.sun.aboveHorizon;

// 2. Soc of Battery in %
const soc = data.battery.soc;
const minimalCharge = data.battery.minSoc;
const dischargeRestartBufferPercent = 1;
const dischargeStopThreshold = minimalCharge + dischargeRestartBufferPercent;

// 2. FORECAST LOGIC (Total Energy Remaining)
// Wh remaining today
const totalSolarRemaining = data.forecast.solarRemainingWh;

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
let nightLowSocBlock = context.get("nightLowSocBlock") || false;
if (!isSolarDayOver) {
    nightLowSocBlock = false;
}
if (isSolarDayOver && soc <= dischargeStopThreshold) {
    nightLowSocBlock = true;
}

const batteryHasReserve = soc > dischargeStopThreshold && !nightLowSocBlock;
msg.action = msg.action || {};
msg.action.battery = msg.action.battery || {};
msg.action.battery.discharge = msg.action.battery.discharge || {};
msg.action.decision = {
    isSolarDayOver,
    batteryHasReserve,
    nightLowSocBlock,
    dischargeStopThreshold
};
const solarPower = derived.solar.livePower;
context.set("nightLowSocBlock", nightLowSocBlock);

if (isSolarDayOver && batteryHasReserve) {
    toDischarge = msg;
    node.status({
        fill: "blue",
        shape: "dot",
        text: `Discharge - Night, remaining solar ${totalSolarRemaining}Wh, reserve above ${dischargeStopThreshold}%`
    });
} else if (isSolarDayOver && nightLowSocBlock) {
    msg.action.battery.discharge.commandPower = 0;
    msg.action.battery.discharge.stopRequested = true;
    msg.action.battery.discharge.blockedByLowSoc = true;
    toDischarge = msg;
    node.status({
        fill: "red",
        shape: "ring",
        text: `Night discharge blocked below ${dischargeStopThreshold}% SoC`
    });
} else if (solarPower > 0) {
    toCharge = msg;
    node.status({
        fill: "yellow",
        shape: "dot",
        text: `Charge - Day/Solar: remaining solar ${totalSolarRemaining}Wh`
    });
} else {
    node.status({
        fill: "red",
        shape: "dot",
        text: `Empty Battery, no solar power: ${solarPower}W, solar forecast ${totalSolarRemaining}Wh, battery soc: ${soc}`
    });
}

return [toCharge, toDischarge];
