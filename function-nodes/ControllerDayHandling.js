// 1. DATA RETRIEVAL
function getFirstFinite(values, fallback = 0) {
    for (const value of values) {
        if (Number.isFinite(value)) {
            return value;
        }
    }

    return fallback;
}

const gridPower = getFirstFinite([msg.data?.grid?.power], 0);
const maxChargePower = getFirstFinite(
    [msg.data?.battery?.chargeHardwareMaxPower, msg.data?.battery?.chargeMaxPower],
    800
);
const batteryInflow = getFirstFinite([msg.data?.battery?.chargePower], 0);
const calculatedDemand = getFirstFinite(
    [msg.derived?.demand?.defensiveTarget, msg.adjustment?.defensiveTarget],
    0
);
const liveSolarPower = getFirstFinite(
    [msg.derived?.solar?.livePower, msg.adjustment?.solarPower, msg.data?.solar?.totalPower],
    0
);
const stableSolarPower = getFirstFinite(
    [msg.derived?.solar?.averagePower, msg.adjustment?.solarAveragePower, liveSolarPower],
    liveSolarPower
);
const solarLiveBlend = 0.35; // Pull part of the live solar into the stable value on cloudy days
const effectiveSolarPower = Math.max(
    stableSolarPower,
    liveSolarPower * solarLiveBlend + stableSolarPower * (1 - solarLiveBlend)
);
const soc = getFirstFinite([msg.data?.battery?.soc], 0);
const minSoc = getFirstFinite([msg.data?.battery?.minSoc], 15);
const currentSetInflow = getFirstFinite([msg.data?.battery?.chargeSetpoint], 0);
const totalProduced = getFirstFinite([msg.data?.solar?.totalPower], 0);
const demandTiming = msg.meta?.sensorTiming?.demand;
const demandTimingThresholds = msg.meta?.sensorTiming?.thresholds || {};
const demandConfidence = demandTiming?.confidence;
const reliableDemandConfidence = Number.isFinite(demandTimingThresholds.reliableConfidence)
    ? demandTimingThresholds.reliableConfidence
    : 0.7;
const gridTimingReading = demandTiming?.sensors?.grid;

// 2. CONFIGURATION (Based on safety buffer strategy)
// this addresses the "Moving Target" problem with huge latencies of smart meter and battery chargine changes:
const targetBuffer = 30; // Aim for 30W import
const maxInverterPower = 1200; // the Inverter limit
const minSustain = 50; // Keep charging circuit active
const exportTolerance = 5; // Ignore tiny meter jitter, react to real export quickly
const exportBoostFactor = 1.25; // Compensate for meter/inverter latency when exporting
const solarSwitchGuardFactor = 0.5; // Avoid charge relay cycling while solar is still available

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
let lastCommand = context.get("lastCommand") || 0;
const lastDemandEstimate = context.get("lastDemandEstimate");

const demandSnapshotReliable =
    !Number.isFinite(demandConfidence) || demandConfidence >= reliableDemandConfidence;
const gridSnapshotReliable = gridTimingReading?.isValid !== false;
const shouldFreezeCommand = !gridSnapshotReliable || !Number.isFinite(gridPower);

if (shouldFreezeCommand) {
    const holdCommand = Math.round(Math.max(lastCommand, currentSetInflow, batteryInflow, 0));
    node.status({
        fill: "green",
        shape: "ring",
        text: `Stable @ ${holdCommand}W`
    });
    return null;
}

function clampChargeCommand(value) {
    let clampedValue = value;

    if (clampedValue > maxInverterPower) {
        clampedValue = maxInverterPower;
        clampReason = "Inverter Max";
    }
    if (clampedValue > maxChargePower) {
        clampedValue = maxChargePower;
        clampReason = "Battery Max";
    }
    if (clampedValue < 0) {
        clampedValue = 0;
        ruleApplied = "Floor (0W)";
    }

    return clampedValue;
}

function emitCommand({ command, targetCharge, theoreticalSurplus, statusFill, statusText }) {
    const roundedCommand = Math.round(command);
    const roundedTarget = Math.round(targetCharge);
    const roundedSurplus = Math.round(theoreticalSurplus);
    const delta = Math.abs(command - lastCommand);

    msg.adjustment.command = roundedCommand;
    msg.adjustment.grid = gridPower;
    msg.derived = msg.derived || {};
    msg.derived.solar = msg.derived.solar || {};
    msg.derived.energy = msg.derived.energy || {};
    msg.derived.solar.effectivePower = Math.round(effectiveSolarPower);
    msg.derived.energy.theoreticalSurplus = roundedSurplus;
    msg.action = msg.action || {};
    msg.action.charge = msg.action.charge || {};
    msg.action.charge.targetPower = roundedTarget;
    msg.action.charge.commandPower = roundedCommand;
    msg.action.charge.ruleApplied = ruleApplied;
    msg.action.charge.clampReason = clampReason;
    context.set("lastCommand", command);
    context.set("lastGridPower", gridPower);
    context.set(
        "lastDemandEstimate",
        getFirstFinite([demandTiming?.currentEstimate, msg.adjustment?.currentDemandEstimate], 0)
    );

    const insights = {
        payload: {
            timestamp: new Date().toISOString(),
            efficiency: {
                gridExport: gridPower < 0 ? Math.abs(gridPower) : 0,
                isLeaking: isExporting
            },
            calculation: {
                theoreticalSurplus: roundedSurplus,
                targetCharge: roundedTarget,
                finalCommand: roundedCommand
            },
            constraints: {
                clamp: clampReason,
                rule: ruleApplied,
                delta: Math.round(delta)
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

    node.status({
        fill: statusFill,
        shape: "dot",
        text: statusText
    });

    return [msg, insights];
}

if (!demandSnapshotReliable) {
    ruleApplied = "Low-Confidence Grid Steering";

    const baseCommand = Math.max(lastCommand, currentSetInflow, 0);
    const currentDemandEstimate = getFirstFinite(
        [demandTiming?.currentEstimate, msg.adjustment?.currentDemandEstimate],
        0
    );
    const demandDelta = Number.isFinite(lastDemandEstimate)
        ? currentDemandEstimate - lastDemandEstimate
        : null;
    let targetCharge = baseCommand;

    if (isExporting) {
        const exportCorrection = Math.abs(gridPower) + targetBuffer;
        const commandAlreadyAheadOfMeasuredInflow = currentSetInflow > batteryInflow + targetBuffer;

        if (commandAlreadyAheadOfMeasuredInflow && Math.abs(gridPower) <= targetBuffer) {
            targetCharge = baseCommand;
        } else if (maxChargePower > 800 || Math.abs(gridPower) <= targetBuffer * 2) {
            targetCharge = baseCommand + exportCorrection;
        }
    } else if (gridPower > targetBuffer) {
        const importCorrection = gridPower - targetBuffer;
        const demandSpike = currentDemandEstimate - calculatedDemand;
        const isShortDemandPeak =
            demandDelta !== null &&
            demandDelta > 0 &&
            demandSpike > 100 &&
            calculatedDemand <= lastDemandEstimate + targetBuffer &&
            gridPower <= targetBuffer * 2;
        if (isShortDemandPeak) {
            targetCharge = baseCommand;
        } else {
            const demandCorrection =
                demandDelta !== null && demandDelta > 0 ? demandDelta * 2 : importCorrection;

            targetCharge = baseCommand - Math.max(importCorrection, demandCorrection);
        }
    }

    const smoothedCommand = clampChargeCommand(targetCharge);
    return emitCommand({
        command: smoothedCommand,
        targetCharge,
        theoreticalSurplus: effectiveSolarPower - calculatedDemand,
        statusFill: isExporting ? "yellow" : "green",
        statusText: `Cmd: ${Math.round(smoothedCommand)}W | Rule: ${ruleApplied} | Grid: ${Math.round(
            gridPower
        )}W`
    });
}

// 3. THE CALCULATION (Grid-Anchor)
const theoreticalSurplus = effectiveSolarPower - calculatedDemand;
let targetCharge = Math.max(0, theoreticalSurplus + targetBuffer);

// If we are exporting, add an explicit anti-export correction on top of the
// stable surplus target so slight leaks are not ignored.
if (isExporting) {
    const exportIntensity = Math.abs(gridPower);
    const exportBoost = Math.round(exportIntensity * exportBoostFactor);
    targetCharge = Math.max(targetCharge, currentSetInflow + exportBoost);
    ruleApplied = "Anti-Export";
}

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

const chargingWasActive = Math.max(lastCommand, currentSetInflow, batteryInflow) > 0;
const solarSwitchGuardFloor = totalProduced * solarSwitchGuardFactor;
if (
    chargingWasActive &&
    totalProduced > productionThreshold &&
    targetCharge < solarSwitchGuardFloor
) {
    targetCharge = solarSwitchGuardFloor;
    ruleApplied = "Solar Floor (Switch Guard)";
}

// 5. DYNAMIC SMOOTHING (Slew Rate)
// Instead of a fixed Alpha, we use a "Fast-Up, Slow-Down" approach.
let finalAlpha;
if (isExporting) {
    // CRITICAL: If we are exporting, we jump to the target IMMEDIATELY
    finalAlpha = 1.0;
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

if (
    chargingWasActive &&
    totalProduced > productionThreshold &&
    smoothedCommand < solarSwitchGuardFloor
) {
    smoothedCommand = solarSwitchGuardFloor;
    ruleApplied = "Solar Floor (Switch Guard)";
}

smoothedCommand = clampChargeCommand(smoothedCommand);

// 7. CYCLE GUARD (Deadband)
// If we are stable and not exporting, don't update if change is tiny
const delta = Math.abs(smoothedCommand - lastCommand);
if (delta < 5 && gridPower >= 0 && batteryInflow === 0) {
    node.status({ fill: "green", shape: "ring", text: `Stable @ ${Math.round(smoothedCommand)}W` });
    return null;
}

// 8. OUTPUTS & PERSISTENCE
return emitCommand({
    command: smoothedCommand,
    targetCharge,
    theoreticalSurplus,
    statusFill: isExporting ? "red" : "green",
    statusText: `Cmd: ${Math.round(smoothedCommand)}W | Clamp: ${clampReason} | Export: ${Math.round(
        gridPower
    )}W`
});
