const data = msg.data || {};
const action = msg.action || {};

// 1. DATA EXTRACTION
const soc = data.battery?.soc || 0;
const maxSoc = data.battery?.socLimit || 100;
const currentInflow = data.battery?.chargePower || 0;
const currentSetInflow = data.battery?.chargeSetpoint || 0;
const maxChargeHardware =
    data.battery?.chargeHardwareMaxPower || data.battery?.chargeMaxPower || 800;
const gridPower = data.grid?.power || 0;

// 2. CORE CALCULATION
let targetCharge = Math.abs(action.charge?.commandPower || 0);

// Add a safety check: If Actual and Set are miles apart (e.g. communication error),
// fallback to a more conservative average.
// To INCREASE charging, we subtract the negative error (e.g., 100 - (-200) = 300)
const gap = Math.abs(currentSetInflow - currentInflow);
if (gap > 100) {
    // Something is wrong (communication lag or manual override)
    // Fallback to Actual to be safe
}

// 3. APPLY RULES & SAFETY
let reason = "Adjusting normally";

// Check: Battery Full
if (soc + 1.1 > maxSoc) {
    targetCharge = 0;
    reason = "BATTERY_FULL_OVERFLOW";
} else if (targetCharge > maxChargeHardware) {
    reason = "MAX_CHARGE_OVERFLOW";
}

// Rule: Hardware Limits
targetCharge = Math.max(0, Math.min(maxChargeHardware, targetCharge));

// 4. LOGGING & OUTPUT
const logMsg = {
    payload: {
        time: new Date().toLocaleString("de-DE"),
        grid: Math.round(gridPower),
        soc: soc,
        targetCharge: Math.round(targetCharge),
        reason: reason
    }
};

// Only trigger the hardware if the change is significant (> 10W)
let hardwareCmd = null;
if (Math.abs(targetCharge - currentSetInflow) > 10) {
    hardwareCmd = { payload: Math.round(targetCharge) };
} else {
    reason = "No change - no need to adjust";
}

node.status({ fill: "green", shape: "dot", text: `${Math.round(targetCharge)}W (${reason})` });

return [hardwareCmd, { payload: reason }, logMsg];
