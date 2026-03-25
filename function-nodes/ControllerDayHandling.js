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
        "derived.demand.trend",
        "derived.demand.trendChanges",
        "derived.solar.livePower",
        "derived.solar.averagePower",
        "derived.solar.trend",
        "derived.solar.trendChanges",
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
const demandTrend = derived.demand.trend;
const demandTrendChanges = derived.demand.trendChanges;
const liveSolarPower = derived.solar.livePower;
const stableSolarPower = derived.solar.averagePower;
const solarTrend = derived.solar.trend;
const solarTrendChanges = derived.solar.trendChanges;
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
const maxInverterPower = 1200; // the Inverter limit
const minSustain = 50; // Keep charging circuit active
const exportTolerance = 5; // Ignore tiny meter jitter, react to real export quickly
const exportBoostFactor = 1.25; // Compensate for meter/inverter latency when exporting
const happyPathDeadband = 15; // Ignore tiny setpoint changes during calm periods
const happyPathRampUpAlpha = 0.35; // Raise charging gently on the happy path
const happyPathRampDownAlpha = 0.15; // Drop charging even more gently on the happy path
const forecastHoldThresholdWh = 50; // Only keep charging warm if more solar is still expected
const warmHoldSolarFraction = 0.5; // Hold at half of the current solar power to avoid charge on/off cycling
const exportMemoryCap = 120; // Keep zero-export bias alive for several delayed cycles
const exportMemoryDecayPerCycle = 20; // Roughly 1-2 minutes until the memory fades out
const maxDynamicImportBuffer = 150; // Never aim for more than this import cushion
const sustainedDeficitThreshold = -40; // Require a real deficit before we release charge quickly
const releaseCyclesRequired = 3; // Several cycles without export before reducing aggressively
const sustainedDeficitCyclesRequired = 3; // Several cycles of deficit before reducing aggressively
const solarRampBoostFactor = 0.35; // Pre-charge when solar rises faster than the stable baseline
const solarTrendBoostFactor = 0.4; // Reinforce pre-charge when the 5-minute trend is rising
const demandTrendPenaltyFactor = 0.25; // Rising demand reduces predicted surplus
const demandTrendPenaltyCap = 30; // Keep trend correction bounded
const softReductionFloorFraction = 0.75; // Lower charge only gradually when evidence is weak
const solarTrendChangeBufferStep = 12; // Add confidence buffer when solar direction changes often
const demandTrendChangeBufferStep = 8; // Add confidence buffer when demand direction changes often
const maxTrendChangeBufferBoost = 40; // Keep trend-change contribution bounded
const solarTrendChangeRampStep = 8; // Extra pre-charge for chaotic solar ramps
const maxTrendChangeRampBoost = 30; // Bound extra ramp boost from trend changes
const unstableLowSolarThreshold = 100; // Objective 4: explicitly keep at least half of low unstable solar
const unstableLowSolarChargeFraction = 0.5; // Minimum charge share of generated solar in low unstable conditions

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
let exportMemoryBias = context.get("exportMemoryBias") || 0;
if (isExporting) {
    exportMemoryBias = Math.min(
        exportMemoryCap,
        Math.max(exportMemoryBias * 0.7, Math.abs(gridPower) * exportBoostFactor + 40)
    );
} else {
    exportMemoryBias = Math.max(0, exportMemoryBias - exportMemoryDecayPerCycle);
}

const baseImportBuffer = isHappyPath
    ? 30
    : stabilityMode === "solar_unstable"
      ? 80
      : stabilityMode === "demand_unstable"
        ? 50
        : 70;
const solarTrendChangeBufferBoost = Math.min(
    maxTrendChangeBufferBoost,
    solarTrendChanges * solarTrendChangeBufferStep
);
const demandTrendChangeBufferBoost = Math.min(
    maxTrendChangeBufferBoost,
    demandTrendChanges * demandTrendChangeBufferStep
);
const positiveDemandTrendPenalty = Math.min(
    demandTrendPenaltyCap,
    Math.round(Math.max(0, demandTrend) * demandTrendPenaltyFactor)
);
const solarRamp = Math.max(0, liveSolarPower - stableSolarPower);
const solarRampBoost = Math.min(
    120 + maxTrendChangeRampBoost,
    Math.round(
        solarRamp * solarRampBoostFactor +
            Math.max(0, solarTrend) * solarTrendBoostFactor +
            Math.min(maxTrendChangeRampBoost, solarTrendChanges * solarTrendChangeRampStep)
    )
);
const dynamicImportBuffer = Math.min(
    maxDynamicImportBuffer,
    Math.round(
        baseImportBuffer +
            exportMemoryBias +
            positiveDemandTrendPenalty +
            solarTrendChangeBufferBoost +
            demandTrendChangeBufferBoost
    )
);
const predictiveDemand = calculatedDemand + positiveDemandTrendPenalty;
const predictiveSolarPower = effectiveSolarPower + solarRampBoost;
const theoreticalSurplus = effectiveSolarPower - calculatedDemand;
const predictiveSurplus = predictiveSolarPower - predictiveDemand;
let noExportCycles = context.get("noExportCycles") || 0;
noExportCycles = isExporting ? 0 : Math.min(12, noExportCycles + 1);
let deficitCycles = context.get("deficitCycles") || 0;
deficitCycles = predictiveSurplus < sustainedDeficitThreshold ? Math.min(12, deficitCycles + 1) : 0;

function appendRule(baseRule, suffix) {
    if (!baseRule || baseRule === "None") {
        return suffix;
    }

    return baseRule.includes(suffix) ? baseRule : `${baseRule} + ${suffix}`;
}

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
        ruleApplied: appendRule(
            nextTargetCharge <= 0 ? "None" : nextRuleApplied,
            "Forecast Warm Hold"
        )
    };
}

function applyUnstableLowSolarMinimum(nextTargetCharge, nextRuleApplied) {
    const isSolarUnstable =
        stability.solar === "unstable" ||
        stabilityMode === "solar_unstable" ||
        stabilityMode === "unstable_unstable";

    if (!isSolarUnstable || totalProduced <= 0 || totalProduced >= unstableLowSolarThreshold) {
        return { targetCharge: nextTargetCharge, ruleApplied: nextRuleApplied, isActive: false };
    }

    const unstableLowSolarMinimum = Math.round(totalProduced * unstableLowSolarChargeFraction);
    if (nextTargetCharge >= unstableLowSolarMinimum) {
        return { targetCharge: nextTargetCharge, ruleApplied: nextRuleApplied, isActive: false };
    }

    return {
        targetCharge: unstableLowSolarMinimum,
        ruleApplied: appendRule(nextRuleApplied, "Unstable Low Solar Minimum"),
        isActive: true
    };
}

function applyReductionGuard(nextTargetCharge, nextRuleApplied) {
    if (nextTargetCharge >= lastCommand || isExporting || lastCommand <= 0) {
        return { targetCharge: nextTargetCharge, ruleApplied: nextRuleApplied, isActive: false };
    }

    const dynamicReleaseCyclesRequired =
        releaseCyclesRequired + Math.min(2, Math.max(solarTrendChanges, demandTrendChanges));
    const dynamicDeficitCyclesRequired =
        sustainedDeficitCyclesRequired + Math.min(2, demandTrendChanges);
    const enoughReleaseHistory = noExportCycles >= dynamicReleaseCyclesRequired;
    const sustainedDeficit = deficitCycles >= dynamicDeficitCyclesRequired;

    if (!enoughReleaseHistory && !sustainedDeficit) {
        return {
            targetCharge: Math.max(nextTargetCharge, Math.round(lastCommand)),
            ruleApplied: appendRule(nextRuleApplied, "Reduction Hold"),
            isActive: true
        };
    }

    const dynamicSoftReductionFloorFraction = Math.min(
        0.9,
        softReductionFloorFraction + Math.min(0.1, solarTrendChanges * 0.03)
    );
    const softReductionFloor = Math.round(lastCommand * dynamicSoftReductionFloorFraction);
    if (!sustainedDeficit && nextTargetCharge < softReductionFloor) {
        return {
            targetCharge: softReductionFloor,
            ruleApplied: appendRule(nextRuleApplied, "Slow Reduction"),
            isActive: true
        };
    }

    return { targetCharge: nextTargetCharge, ruleApplied: nextRuleApplied, isActive: false };
}

// Specification:
// Use the calm 5-minute surplus when both solar and demand are stable,
// keep battery changes gentle, and only react quickly when export appears.
function calculateHappyPathCharge() {
    let nextTargetCharge = Math.max(0, predictiveSurplus + dynamicImportBuffer);
    let nextRuleApplied = solarRampBoost > 0 ? "Happy Path + Solar Ramp" : "Happy Path";

    if (isExporting) {
        const exportIntensity = Math.abs(gridPower);
        const exportBoost = Math.round(exportIntensity * Math.max(1, exportBoostFactor * 0.7));
        nextTargetCharge = Math.max(nextTargetCharge, currentSetInflow + exportBoost);
        nextRuleApplied = "Anti-Export";
    } else if (predictiveSurplus <= 0) {
        nextTargetCharge = 0;
        nextRuleApplied = "Happy Path Idle";
    }

    return { targetCharge: nextTargetCharge, ruleApplied: nextRuleApplied };
}

// Specification:
// Use the more defensive default controller for unstable situations,
// with stronger grid-anchored anti-export correction.
function calculateDefaultCharge() {
    let nextTargetCharge = Math.max(0, predictiveSurplus + dynamicImportBuffer);
    let nextRuleApplied = solarRampBoost > 0 ? "Predictive + Solar Ramp" : "Predictive";

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
const unstableLowSolarAdjustment = applyUnstableLowSolarMinimum(targetCharge, ruleApplied);
targetCharge = unstableLowSolarAdjustment.targetCharge;
ruleApplied = unstableLowSolarAdjustment.ruleApplied;
const unstableLowSolarActive = unstableLowSolarAdjustment.isActive;
const warmHoldAdjustment = applyForecastWarmHold(targetCharge, ruleApplied);
targetCharge = warmHoldAdjustment.targetCharge;
ruleApplied = warmHoldAdjustment.ruleApplied;
const reductionGuard = applyReductionGuard(targetCharge, ruleApplied);
targetCharge = reductionGuard.targetCharge;
ruleApplied = reductionGuard.ruleApplied;
const reductionGuardActive = reductionGuard.isActive;

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
} else if (reductionGuardActive) {
    finalAlpha = 0.1;
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

context.set("exportMemoryBias", exportMemoryBias);
context.set("noExportCycles", noExportCycles);
context.set("deficitCycles", deficitCycles);
context.set("lastCommand", smoothedCommand);

msg.derived = derived;
msg.derived.solar = msg.derived.solar || {};
msg.derived.solar.effectivePower = Math.round(effectiveSolarPower);
msg.derived.energy = msg.derived.energy || {};
msg.derived.energy.theoreticalSurplus = Math.round(theoreticalSurplus);
msg.derived.energy.predictiveSurplus = Math.round(predictiveSurplus);

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
            predictiveSurplus: Math.round(predictiveSurplus),
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
            solarPredictive: Math.round(predictiveSolarPower),
            demand: calculatedDemand,
            demandPredictive: Math.round(predictiveDemand),
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
        predictiveSolarPower: Math.round(predictiveSolarPower),
        theoreticalSurplus: Math.round(theoreticalSurplus),
        predictiveSurplus: Math.round(predictiveSurplus),
        targetCharge: Math.round(targetCharge),
        finalCommand: roundedCommand,
        delta: Math.round(delta),
        soc: Math.round(soc),
        minSoc: Math.round(minSoc),
        totalProduced: Math.round(totalProduced),
        totalSolarRemaining: Math.round(totalSolarRemaining),
        unstableLowSolarActive: unstableLowSolarActive,
        forecastWarmHoldActive: isChargingActive && hasMeaningfulSolarForecast && !isExporting,
        reductionGuardActive: reductionGuardActive,
        dynamicImportBuffer: Math.round(dynamicImportBuffer),
        baseImportBuffer: Math.round(baseImportBuffer),
        exportMemoryBias: Math.round(exportMemoryBias),
        noExportCycles: noExportCycles,
        deficitCycles: deficitCycles,
        demandTrend: Math.round(demandTrend),
        demandTrendChanges: demandTrendChanges,
        solarTrend: Math.round(solarTrend),
        solarTrendChanges: solarTrendChanges,
        solarTrendChangeBufferBoost: Math.round(solarTrendChangeBufferBoost),
        demandTrendChangeBufferBoost: Math.round(demandTrendChangeBufferBoost),
        solarRampBoost: Math.round(solarRampBoost),
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
