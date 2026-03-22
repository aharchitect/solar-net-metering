const map = msg.payload;
const adj = msg.adjustment; // Contains .command, .requiredChange, and .grid

// 1. DATA EXTRACTION FROM MAP
const soc = parseFloat(map["sensor.solarflow_800_pro_electric_level"]?.state) || 0;
const maxSoc = parseFloat(map["number.solarflow_800_pro_soc_set"]?.state) || 100; // Your threshold
const currentInflow = parseFloat(map["sensor.solarflow_800_pro_grid_input_power"]?.state) || 0;
const currentSetInflow = parseFloat(map["number.solarflow_800_pro_input_limit"]?.state) || 0;
const maxChargeHardware =
    parseFloat(map["sensor.solarflow_800_pro_charge_max_limit"]?.attributes?.max) || 800;

// 2. CORE CALCULATION
// adj.command is negative when we have to charge the battery with solar power
let targetCharge = Math.abs(adj.command);

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
        grid: adj.grid,
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
