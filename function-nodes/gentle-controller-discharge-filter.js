// 1. DATA RETRIEVAL
const data = msg.data || {};
const derived = msg.derived || {};
const action = msg.action || {};
const gridPower = data.grid?.power || 0;
const currentBatteryOut = data.battery?.dischargePower || 0;
const calculatedDemand = derived.demand?.defensiveTarget || 0;
const solarPower = derived.solar?.livePower || 0;
const forcedDischarge = action.battery?.discharge?.forcedRate || 0;

// 2. CONFIGURATION (Based on safety buffer strategy)
// this addresses the "Moving Target" problem with huge latencies of smart meter and battery chargine changes:
//   1. The Deadband(deadband = 75): This is your Cycle - Killer.
//                                   It stops the battery from chasing the "ghosts" of small appliances.
//                                   If your fridge compressor flickers, the battery ignores it.
//
//   2. The Safety Buffer(-30): By aiming for a 30W import, you create a "cushion."
//                              When a cloud disappears and solar spikes, you have 30W of "room" before
//                              starting to feed-in into public grid.
//
//   3. The EMA(alpha = 0.9): This solves the 50s latency of smart meter and battery.
//                            Instead of jumping to a new value every 20s (init trigger) and
//                            overshooting, the battery "slides" toward the new value. This reduces the
//                            chemical stress on the LiFePO4 cells.

const targetBuffer = -50; // Aim for 50W import to prevent feed-in
const deadband = 50; // Ignore fluctuations smaller than 50W
const alpha = 0.3; // EMA Smoothing factor (0.1 = very slow, 0.9 = very fast)

// 3. CALCULATION
// calculated Demand is the brutto demand of power, solar power the generated and usable power.
// default expects, that there is more solar power than demand,
// e.g. 10W (solar) - 300W (demand) - (-30) = -260W to discharge
//       0W (solar) - 50W (demand) - (-30) = -20W to discharge
//     100W (solar) - 200W (demand) - (-30) = -70W to discharge
//       0W (solar) - 200W (demand) - (-30) = -170W to discharge
//       1W (solar) - 201W (demand) - (-30) = -170W to discharge
//       0W (solar) - (-50)W (demand) - (-30) = 80W to adjust or even stop discharging (discharging is at least 50W)
let requiredChange = solarPower - calculatedDemand - targetBuffer;

// 4. THE CYCLE GUARD (Dynamic Deadband)
// If the requiredChange is small AND we aren't "exporting", stay still to save battery cycles
if (Math.abs(requiredChange) < deadband && gridPower > 0 && currentBatteryOut == 0) {
    node.status({
        fill: "green",
        shape: "dot",
        text: `Done (deadband) - Stable power - finish (calculated change is ${Math.round(requiredChange)}W, grid power: ${Math.round(gridPower)}W)`
    });
    return null; // Stop the message here; no command sent to inverter
}

// 5. EMA SMOOTHING (The "Lag Compensator")
let lastCommand = context.get("lastCommand") || 0;
let rawCommand = requiredChange * -1; // invert to represent the power gap required from battery

if (rawCommand < 0 && currentBatteryOut > 0) {
    // demand is larger than solar power but still solar power available
    rawCommand = (requiredChange - targetBuffer - currentBatteryOut) * -1; // 80W - 30 - 60 = -10 -> reduce discharging before stopping
}

// Apply Exponential Moving Average
let smoothedCommand = rawCommand * alpha + lastCommand * (1 - alpha);

// 5. THE ZERO-EXPORT DEFENSE (The "No-Penalty" Guard)
// --> EMERGENCY BRAKE
if (gridPower < 0) {
    smoothedCommand = Math.max(0, currentBatteryOut + gridPower + targetBuffer);
}

smoothedCommand = Math.min(smoothedCommand, forcedDischarge * 2.5);

// Only output if the command actually changed significantly (e.g., > 5W)
if (Math.abs(smoothedCommand - lastCommand) < 5 && gridPower > 0 && currentBatteryOut == 0) {
    node.status({
        fill: "green",
        shape: "dot",
        text: `Idle (deadband) - Hardly changed power - finish: ${Math.round(smoothedCommand)}W, grid Power ${gridPower}W`
    });
    return null;
}

// 6. FINAL OUTPUT & PERSISTENCE
context.set("lastCommand", smoothedCommand);

msg.action = action;
msg.action.battery = msg.action.battery || {};
msg.action.battery.discharge = msg.action.battery.discharge || {};
msg.action.battery.discharge.commandPower = Math.round(smoothedCommand);
msg.action.battery.discharge.requiredChange = Math.round(requiredChange);
msg.action.battery.discharge.isStable = Math.abs(requiredChange) < deadband;
msg.action.battery.discharge.gridPower = Math.round(gridPower);

node.status({
    fill: "green",
    shape: "dot",
    text: `Calculated Power (smoothed): ${Math.round(smoothedCommand)}W`
});
return msg;
