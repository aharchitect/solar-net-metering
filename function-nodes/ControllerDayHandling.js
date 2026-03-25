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
        "data.grid.power",
        "data.battery.chargeMaxPower",
        "data.battery.chargePower",
        "data.battery.soc",
        "data.battery.minSoc",
        "data.battery.chargeSetpoint",
        "data.forecast.solarRemainingWh",
        "data.solar.totalPower",
        "derived.demand.defensiveTarget",
        "derived.solar.livePower",
        "derived.solar.averagePower",
        "meta.stability.mode"
    ])
) {
    return null;
}

// 1. DATA RETRIEVAL (Using the normalized input message)
const data = msg.data;
const derived = msg.derived;
const action = msg.action || {};
const gridPower = data.grid.power;
const maxChargePower = data.battery.chargeMaxPower;
const batteryInflow = data.battery.chargePower;
const calculatedDemand = derived.demand.defensiveTarget;
const liveSolarPower = derived.solar.livePower;
const stableSolarPower = derived.solar.averagePower;
const stability = msg.meta.stability;
const stabilityMode = stability.mode;
const isHappyPath = stabilityMode === "stable_stable";
const solarLiveBlend = 0.35; // Pull part of the live solar into the stable value on cloudy days
const effectiveSolarPower = Math.max(
    stableSolarPower,
    liveSolarPower * solarLiveBlend + stableSolarPower * (1 - solarLiveBlend)
);
const soc = data.battery.soc;
const minSoc = data.battery.minSoc;
const currentSetInflow = data.battery.chargeSetpoint;
const totalSolarRemaining = data.forecast.solarRemainingWh;
const totalProduced = data.solar.totalPower;

// 2. CONFIGURATION (Based on safety buffer strategy)
// this addresses the "Moving Target" problem with huge latencies of smart meter and battery chargine changes:
const targetBuffer = 30; // Aim for 30W import
const maxInverterPower = 1200; // the Inverter limit
const minSustain = 50; // Keep charging circuit active
const exportTolerance = 5; // Ignore tiny meter jitter, react to real export quickly
const exportBoostFactor = 1.25; // Compensate for meter/inverter latency when exporting
const happyPathDeadband = 15; // Ignore tiny setpoint changes during calm periods
const happyPathRampUpAlpha = 0.35; // Raise charging gently on the happy path
const happyPathRampDownAlpha = 0.15; // Drop charging even more gently on the happy path
const forecastHoldThresholdWh = 50; // Only keep charging warm if more solar is still expected
const warmHoldSolarFraction = 0.5; // Hold at half of the current solar power to avoid charge on/off cycling

// calculated Demand is the brutto demand of power, solar power the generated and usable power.
// default expects that there is more solar power than demand,
// e.g. 1000W (solar) - 300W (demand) + 30W buffer = 730W to charge
//      300W (solar) - 350W (demand) + 30W buffer = -20W hardly necessary to charge
//      200W (solar) - 200W (demand) + 30W buffer = 30W to charge
//        0W (solar) - 200W (demand) + 30W buffer = -170W do not charge
//        1W (solar) - 201W (demand) + 30W buffer = -170W stop charging
//  --- SAFETY RULES & CLAMPING
let clampReason = "None";
let ruleApplied = "None";
const isExporting = gridPower < -exportTolerance;
const lastCommand = context.get("lastCommand") || 0;
const isChargingActive = Math.max(lastCommand, currentSetInflow, batteryInflow) > 5;
const hasMeaningfulSolarForecast = totalSolarRemaining > forecastHoldThresholdWh;

const theoreticalSurplus = effectiveSolarPower - calculatedDemand;

function applyForecastWarmHold(nextTargetCharge, nextRuleApplied) {
    if (!isChargingActive || !hasMeaningfulSolarForecast || isExporting || totalProduced <= 0) {
        return { targetCharge: nextTargetCharge, ruleApplied: nextRuleApplied };
    }

    const warmHoldPower = Math.max(minSustain, Math.round(totalProduced * warmHoldSolarFraction));
    if (nextTargetCharge >= warmHoldPower) {
        return { targetCharge: nextTargetCharge, ruleApplied: nextRuleApplied };
    }

    return {
        targetCharge: warmHoldPower,
        ruleApplied:
            nextTargetCharge <= 0 ? "Forecast Warm Hold" : `${nextRuleApplied} + Forecast Warm Hold`
    };
}

// Specification:
// Use the calm 5-minute surplus when both solar and demand are stable,
// keep battery changes gentle, and only react quickly when export appears.
function calculateHappyPathCharge() {
    const happyPathBuffer = 20; // Smaller reserve when solar and demand are both calm

    let nextTargetCharge = Math.max(0, theoreticalSurplus + happyPathBuffer);
    let nextRuleApplied = "Happy Path";

    if (isExporting) {
        const exportIntensity = Math.abs(gridPower);
        const exportBoost = Math.round(exportIntensity * Math.max(1, exportBoostFactor * 0.7));
        nextTargetCharge = Math.max(nextTargetCharge, currentSetInflow + exportBoost);
        nextRuleApplied = "Anti-Export";
    } else if (theoreticalSurplus <= 0) {
        nextTargetCharge = 0;
        nextRuleApplied = "Happy Path Idle";
    }

    return { targetCharge: nextTargetCharge, ruleApplied: nextRuleApplied };
}

// Specification:
// Use the more defensive default controller for unstable situations,
// with stronger grid-anchored anti-export correction.
function calculateDefaultCharge() {
    let nextTargetCharge = Math.max(0, theoreticalSurplus + targetBuffer);
    let nextRuleApplied = "None";

    if (isExporting) {
        const exportIntensity = Math.abs(gridPower);
        const exportBoost = Math.round(exportIntensity * exportBoostFactor);
        nextTargetCharge = Math.max(nextTargetCharge, currentSetInflow + exportBoost);
        nextRuleApplied = "Anti-Export";
    }

    return { targetCharge: nextTargetCharge, ruleApplied: nextRuleApplied };
}

// 3. THE CALCULATION (Grid-Anchor)
const calculation = isHappyPath ? calculateHappyPathCharge() : calculateDefaultCharge();
let targetCharge = calculation.targetCharge;
ruleApplied = calculation.ruleApplied;
const warmHoldAdjustment = applyForecastWarmHold(targetCharge, ruleApplied);
targetCharge = warmHoldAdjustment.targetCharge;
ruleApplied = warmHoldAdjustment.ruleApplied;

// 4. SANITY CHECKS & SUSTAIN
// If solar production is > 150W, we keep the charging circuit 'warm' at 50W,
// even if the house is currently importing from the grid.
const productionThreshold = 150; // Adjust this based on your 'sunny enough' preference

if (totalProduced > productionThreshold && targetCharge < minSustain) {
    targetCharge = minSustain;
    ruleApplied = "Sustain (Production)";
    // If we are sustained at 50W, but we are still exporting, nudge the charge
    // above sustain to swallow the leak.
    if (isExporting) {
        targetCharge = Math.max(targetCharge, minSustain + Math.abs(gridPower));
        ruleApplied = "Sustain + Anti-Leak";
    }
}

// Keep the Solar Ceiling safety
const solarCeiling = theoreticalSurplus + 100;
if (targetCharge > solarCeiling && !isExporting) {
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
// Instead of a fixed Alpha, we use a "Fast-Up, Slow-Down" approach.
let finalAlpha;
if (isExporting) {
    // CRITICAL: If we are exporting, we jump to the target IMMEDIATELY
    finalAlpha = 1.0;
} else if (isHappyPath && targetCharge > lastCommand) {
    finalAlpha = happyPathRampUpAlpha;
} else if (isHappyPath) {
    finalAlpha = happyPathRampDownAlpha;
} else if (targetCharge > lastCommand) {
    // If we are increasing charge (but not leaking), move fast
    finalAlpha = 0.9;
} else {
    // If we are decreasing charge, move slowly to stay "warm"
    finalAlpha = 0.2;
}
let smoothedCommand = targetCharge * finalAlpha + lastCommand * (1 - finalAlpha);

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
if (delta < (isHappyPath ? happyPathDeadband : 5) && gridPower >= 0 && batteryInflow === 0) {
    node.status({ fill: "green", shape: "ring", text: `Stable @ ${Math.round(smoothedCommand)}W` });
    return null;
}

// 8. OUTPUTS & PERSISTENCE
const roundedCommand = Math.round(smoothedCommand);

context.set("lastCommand", smoothedCommand);

msg.derived = derived;
msg.derived.solar = msg.derived.solar || {};
msg.derived.solar.effectivePower = Math.round(effectiveSolarPower);
msg.derived.energy = msg.derived.energy || {};
msg.derived.energy.theoreticalSurplus = Math.round(theoreticalSurplus);

msg.action = action;
msg.action.charge = {
    targetPower: Math.round(targetCharge),
    commandPower: roundedCommand,
    ruleApplied: ruleApplied,
    clampReason: clampReason
};

const insights = {
    payload: {
        timestamp: new Date().toISOString(),
        efficiency: { gridExport: gridPower < 0 ? Math.abs(gridPower) : 0, isLeaking: isExporting },
        calculation: {
            theoreticalSurplus: Math.round(theoreticalSurplus),
            targetCharge: Math.round(targetCharge),
            finalCommand: roundedCommand
        },
        constraints: {
            clamp: clampReason,
            rule: ruleApplied,
            delta: Math.round(delta),
            mode: stabilityMode
        },
        sensors: {
            solarLive: liveSolarPower,
            solarStable: stableSolarPower,
            solarEffective: Math.round(effectiveSolarPower),
            demand: calculatedDemand,
            grid: gridPower,
            soc: soc
        }
    }
};

const telemetry = {
    payload: {
        time: new Date().toISOString(),
        source: "controller_day_handling",
        mode: stabilityMode,
        ruleApplied: ruleApplied,
        clampReason: clampReason,
        gridPower: Math.round(gridPower),
        batteryInflow: Math.round(batteryInflow),
        currentSetInflow: Math.round(currentSetInflow),
        maxChargePower: Math.round(maxChargePower),
        calculatedDemand: Math.round(calculatedDemand),
        currentDemand: Math.round(msg.derived?.demand?.current ?? calculatedDemand),
        medianDemand: Math.round(msg.derived?.demand?.median ?? calculatedDemand),
        liveSolarPower: Math.round(liveSolarPower),
        stableSolarPower: Math.round(stableSolarPower),
        effectiveSolarPower: Math.round(effectiveSolarPower),
        theoreticalSurplus: Math.round(theoreticalSurplus),
        targetCharge: Math.round(targetCharge),
        finalCommand: roundedCommand,
        delta: Math.round(delta),
        soc: Math.round(soc),
        minSoc: Math.round(minSoc),
        totalProduced: Math.round(totalProduced),
        totalSolarRemaining: Math.round(totalSolarRemaining),
        forecastWarmHoldActive: isChargingActive && hasMeaningfulSolarForecast && !isExporting,
        isExporting: isExporting,
        historySamples: msg.meta?.history?.samples ?? null,
        triggerIntervalSeconds: msg.meta?.history?.triggerIntervalSeconds ?? null,
        demandStdDev: msg.derived?.demand?.stdDev ?? null,
        solarStdDev: msg.derived?.solar?.stdDev ?? null
    },
    insights: insights.payload
};

// Update node status to show the most important "Why"
node.status({
    fill: isExporting ? "red" : "green",
    shape: "dot",
    text: `Cmd: ${roundedCommand}W | ${stabilityMode} | Export: ${Math.round(gridPower)}W`
});

return [msg, telemetry];
