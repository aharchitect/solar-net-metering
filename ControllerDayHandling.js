// 1. DATA RETRIEVAL (Using the Map in the input message)
const ha = msg.payload;
const gridPower = parseFloat(ha["sensor.smartmeter_keller_sml_watt_summe"]?.state) || 0;
const maxChargePower = parseFloat(ha["sensor.solarflow_800_pro_charge_max_limit"]?.state) || 800;
const batteryInflow = parseFloat(ha["sensor.solarflow_800_pro_grid_input_power"]?.state) || 0;
const calculatedDemand = msg.adjustment.defensiveTarget;
const smoothedSolarPower = msg.adjustment.solarPower;
const soc = parseFloat(ha["sensor.solarflow_800_pro_electric_level"]?.state) || 0;
const minSoc = parseFloat(ha["number.solarflow_800_pro_min_soc"]?.state) || 15;
const currentSetInflow = parseFloat(ha["number.solarflow_800_pro_input_limit"]?.state) || 0;
const totalProduced = (parseFloat(ha["sensor.hoymiles600_power"]?.state) || 0) + (parseFloat(ha["sensor.wechselrichter_ac_leistung"]?.state) || 0);

// 2. CONFIGURATION (Based on safety buffer strategy)
// this addresses the "Moving Target" problem with huge latencies of smart meter and battery chargine changes:
const targetBuffer = -30;         // Aim for 30W import
const deadband = 50;              // Stability zone ignore fluctuations smaller than 50W
const maxInverterPower = 1200;    // the Inverter limit
const minSustain = 50;            // Keep charging circuit active

// calculated Demand is the brutto demand of power, solar power the generated and usable power.
// default expects, that there is more solar power than demand, 
// e.g. 1000W (solar) - 300W (demand) - (-30) = 730W to charge
//      300W (solar) - 350W (demand) - (-30) = -20W  - hardly necessary to charge but grid -10 => 40 W charge
//      200W (solar) - 200W (demand) - (-30) = 30W  to charge
//        0W (solar) - 200W (demand) - (-30) = -170W  to discharge
//        1W (solar) - 201W (demand) - (-30) = -170W  to adjust to 0 (stop charging)
//  --- SAFETY RULES & CLAMPING
let clampReason = "None";
let ruleApplied = "None";

// 3. THE CALCULATION (Grid-Anchor)
let gridGap = targetBuffer - gridPower;
let targetCharge = currentSetInflow + gridGap;
// If we are exporting (gridPower < 0), we want to be much more aggressive.
// We add a 'Proportional Boost' to the gap to overcome system latency.
if (gridPower < targetBuffer) {
    const exportIntensity = Math.abs(gridPower);
    // Increase the gap by 50% of the export to force a faster rise
    gridGap = gridGap + (exportIntensity * 0.5); 
}

// 4. SANITY CHECKS & SUSTAIN
const theoreticalSurplus = (smoothedSolarPower - calculatedDemand);
// If solar production is > 150W, we keep the charging circuit 'warm' at 50W,
// even if the house is currently importing from the grid.
const productionThreshold = 150; // Adjust this based on your 'sunny enough' preference

if (totalProduced > productionThreshold && targetCharge < minSustain) {
    targetCharge = minSustain;
    ruleApplied = "Sustain (Production)";
    // THE MISSING LINK: The "Boost"
    // If we are sustained at 50W, but we are STILL exporting (gridPower < 0),
    // we should nudge the charge up to swallow that export.
    if (gridPower < targetBuffer) {
        targetCharge = targetCharge + Math.abs(gridPower); 
        ruleApplied = "Sustain + Anti-Leak";
    }
}

// Keep the Solar Ceiling safety
const solarCeiling = theoreticalSurplus + 100; 
if (targetCharge > solarCeiling && gridPower > targetBuffer) {
    // But we don't want to charge from the grid! 
    // If targetCharge is Sustain(50) but theoreticalSurplus is -58, 
    // we need to decide if we 'waste' 50W of grid power to keep the battery warm.
    // Let's allow it ONLY if the deficit isn't massive.
    if (theoreticalSurplus < -200) { 
        targetCharge = 0; // House is too hungry, give up on sustain.
    }
}

// Minimum Sustain: If sun is out, stay at 50W even if demand is high
if (theoreticalSurplus > 10 && targetCharge < minSustain) {
    targetCharge = minSustain;
}

// Hard floor
if (targetCharge < 0) targetCharge = 0;

// 5. DYNAMIC SMOOTHING (Slew Rate)
let lastCommand = context.get('lastCommand') || 0;
// Instead of a fixed Alpha, we use a "Fast-Up, Slow-Down" approach.
let finalAlpha;
if (gridPower < targetBuffer) {
    // CRITICAL: If we are exporting, we jump to the target IMMEDIATELY
    finalAlpha = 1.0; 
} else if (targetCharge > lastCommand) {
    // If we are increasing charge (but not leaking), move fast
    finalAlpha = 0.9;
} else {
    // If we are decreasing charge, move slowly to stay "warm"
    finalAlpha = 0.2;
}
let smoothedCommand = (targetCharge * finalAlpha) + (lastCommand * (1 - finalAlpha));

// Current state: How much are we currently charging?
const currentCharging = currentSetInflow;

// Rule: Minimum SoC Recovery
if (soc <= minSoc && totalProduced >= 150) {
    const recoveryCharge = totalProduced / 2;
    if (smoothedCommand < recoveryCharge) {
        smoothedCommand = recoveryCharge;
        ruleApplied = "SoC Recovery";
    }
}

// Clamp to Hardware Limits
if (smoothedCommand > maxInverterPower) {
    smoothedCommand = maxInverterPower;
    clampReason = "Inverter Max";
}
if (smoothedCommand > maxChargePower) {
    smoothedCommand = maxChargePower;
    clampReason = "Battery Max";
}
// Rule: Hard Floor
if (smoothedCommand < 0) {
    smoothedCommand = 0;
    ruleApplied = "Floor (0W)";
}

// 7. CYCLE GUARD (Deadband)
// If we are stable and not exporting, don't update if change is tiny
const delta = Math.abs(smoothedCommand - lastCommand);
if (delta < 5 && gridPower > 0 && batteryInflow == 0) {
    node.status({ fill: "green", shape: "ring", text: `Stable @ ${Math.round(smoothedCommand)}W` });
    return null;
}

// 8. OUTPUTS & PERSISTENCE
context.set('lastCommand', smoothedCommand);
const roundedCommand = Math.round(smoothedCommand);

// Store the results in their own property, keeping the map safe
msg.adjustment.command = roundedCommand;
msg.adjustment.grid = gridPower;



// Only output if the command actually changed significantly (e.g., > 5W)
if (Math.abs(smoothedCommand - lastCommand) < 5 && gridPower > 0 && batteryInflow == 0) {
    node.status({
        fill: "green", shape: "dot", text: `Idle (deadband) - Hardly changed power - finish: ${Math.round(smoothedCommand)}W, grid Power ${gridPower}W` });
    return null;
}

// 6. FINAL OUTPUT & PERSISTENCE
context.set('lastCommand', smoothedCommand);

const insights = {
    payload: {
        timestamp: new Date().toISOString(),
        efficiency: { gridExport: gridPower < 0 ? Math.abs(gridPower) : 0, isLeaking: gridPower < targetBuffer },
        calculation: { theoreticalSurplus: Math.round(theoreticalSurplus), targetCharge: Math.round(targetCharge), finalCommand: roundedCommand },
        constraints: { clamp: clampReason, rule: ruleApplied, delta: Math.round(delta) },
        sensors: { solar: smoothedSolarPower, demand: calculatedDemand, grid: gridPower, soc: soc }
    }
};

// Update node status to show the most important "Why"
node.status({
    fill: gridPower < targetBuffer ? "red" : "green",
    shape: "dot",
    text: `Cmd: ${roundedCommand}W | Clamp: ${clampReason} | Export: ${Math.round(gridPower)}W`
});

return [msg, insights];