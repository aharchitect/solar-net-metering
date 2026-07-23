// 1. Calculate current real house demand from normalized inputs only.

if (!msg.meta) {
    msg.meta = {};
}
if (!msg.derived) {
    msg.derived = {};
}
msg.derived.demand = msg.derived.demand || {};
msg.derived.solar = msg.derived.solar || {};

function readNormalizedInput(key, semanticPath, value) {
    const reading = msg.meta?.normalization?.readings?.[key];
    const isValid = Number.isFinite(value) && reading?.isValid !== false;

    return {
        entityId: reading?.entityId || semanticPath,
        rawState: reading?.rawState ?? null,
        value: isValid ? value : 0,
        isValid,
        timestamp: reading?.sourceTimestamp ?? null,
        timestampMs: reading?.sourceTimestampMs ?? null,
        ageMs: reading?.sourceAgeMs ?? null,
        timestampSource: reading?.sourceTimestampField ?? null,
        isStale: reading.isStale === true,
        usedLastValid: reading.usedLastValid === true,
        usedFallback: reading.usedFallback === true
    };
}

function buildAgeStats(readings) {
    const ages = readings.map((reading) => reading.ageMs).filter(Number.isFinite);
    if (ages.length === 0) {
        return {
            minAgeMs: null,
            maxAgeMs: null,
            spreadMs: null,
            averageAgeMs: null
        };
    }

    const minAgeMs = Math.min(...ages);
    const maxAgeMs = Math.max(...ages);
    const totalAgeMs = ages.reduce((sum, ageMs) => sum + ageMs, 0);

    return {
        minAgeMs,
        maxAgeMs,
        spreadMs: maxAgeMs - minAgeMs,
        averageAgeMs: totalAgeMs / ages.length
    };
}

function hasActivePower(reading, threshold = 5) {
    return Math.abs(reading.value) > threshold;
}

function hasRelevantSolarReading(reading, sunAboveHorizon) {
    return hasActivePower(reading) || (sunAboveHorizon && reading.isValid);
}

function buildDemandTimingReadings({
    grid,
    batteryDischarge,
    solarPrimary,
    solarSecondary,
    batteryCharge,
    sunAboveHorizon
}) {
    return [
        grid,
        ...(hasActivePower(batteryDischarge) ? [batteryDischarge] : []),
        ...(hasRelevantSolarReading(solarPrimary, sunAboveHorizon) ? [solarPrimary] : []),
        ...(hasRelevantSolarReading(solarSecondary, sunAboveHorizon) ? [solarSecondary] : []),
        ...(hasActivePower(batteryCharge) ? [batteryCharge] : [])
    ];
}

function clamp01(value) {
    return Math.max(0, Math.min(1, value));
}

function calculateConfidence(ageStats, thresholds, forceZero = false) {
    if (forceZero) {
        return 0;
    }

    const ageConfidence =
        ageStats.maxAgeMs === null ? 1 : clamp01(1 - ageStats.maxAgeMs / thresholds.maxSensorAgeMs);
    const spreadConfidence =
        ageStats.spreadMs === null
            ? 1
            : clamp01(1 - ageStats.spreadMs / thresholds.maxSensorSpreadMs);

    return Math.min(ageConfidence, spreadConfidence);
}

function blendWithFallback(liveValue, fallbackValue, confidence) {
    return liveValue * confidence + fallbackValue * (1 - confidence);
}

function average(values) {
    return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function standardDeviation(values) {
    if (values.length === 0) {
        return 0;
    }

    const mean = average(values);
    const variance = average(values.map((value) => (value - mean) ** 2));
    return Math.sqrt(variance);
}

function percentile(sortedValues, ratio) {
    if (sortedValues.length === 0) {
        return 0;
    }

    const index = Math.min(
        sortedValues.length - 1,
        Math.max(0, Math.floor((sortedValues.length - 1) * ratio))
    );
    return sortedValues[index];
}

function calculateTrend(values) {
    if (values.length < 2) {
        return 0;
    }

    return values[values.length - 1] - values[0];
}

function classifyTrend(trend, deadband) {
    if (trend > deadband) {
        return "up";
    }
    if (trend < -deadband) {
        return "down";
    }
    return "flat";
}

function countTrendChanges(values, deadband) {
    let changes = 0;
    let previousDirection = "flat";

    for (let index = 1; index < values.length; index += 1) {
        const direction = classifyTrend(values[index] - values[index - 1], deadband);
        if (
            direction !== "flat" &&
            previousDirection !== "flat" &&
            direction !== previousDirection
        ) {
            changes += 1;
        }
        if (direction !== "flat") {
            previousDirection = direction;
        }
    }

    return changes;
}

const triggerIntervalSeconds =
    msg.meta?.trigger?.intervalSeconds || flow.get("triggerIntervalSeconds") || 20;
const historyWindowSeconds = 5 * 60;
const historySamples = Math.max(15, Math.ceil(historyWindowSeconds / triggerIntervalSeconds));
const timingThresholds = {
    maxSensorAgeMs: Math.max(45 * 1000, triggerIntervalSeconds * 4 * 1000),
    maxSensorSpreadMs: Math.max(25 * 1000, Math.round(triggerIntervalSeconds * 2.5 * 1000)),
    reliableConfidence: 0.7
};

const gridReading = readNormalizedInput("gridPower", "msg.data.grid.power", msg.data?.grid?.power);
const batteryDischargeReading = readNormalizedInput(
    "batteryDischargePower",
    "msg.data.battery.dischargePower",
    msg.data?.battery?.dischargePower
);
const solarPrimaryReading = readNormalizedInput(
    "solarPrimaryPower",
    "msg.data.solar.primaryPower",
    msg.data?.solar?.primaryPower
);
const solarSecondaryReading = readNormalizedInput(
    "solarSecondaryPower",
    "msg.data.solar.secondaryPower",
    msg.data?.solar?.secondaryPower
);
const batteryChargeReading = readNormalizedInput(
    "batteryChargePower",
    "msg.data.battery.chargePower",
    msg.data?.battery?.chargePower
);
const sunAboveHorizon = msg.data?.sun?.aboveHorizon === true;

const demandTimingReadings = buildDemandTimingReadings({
    grid: gridReading,
    batteryDischarge: batteryDischargeReading,
    solarPrimary: solarPrimaryReading,
    solarSecondary: solarSecondaryReading,
    batteryCharge: batteryChargeReading,
    sunAboveHorizon
});
const solarTimingReadings = [solarPrimaryReading, solarSecondaryReading].filter((reading) =>
    hasRelevantSolarReading(reading, sunAboveHorizon)
);
const demandAgeStats = buildAgeStats(demandTimingReadings);
const solarAgeStats = buildAgeStats(solarTimingReadings);

const currentDemandRaw =
    gridReading.value +
    batteryDischargeReading.value +
    solarPrimaryReading.value +
    solarSecondaryReading.value -
    batteryChargeReading.value;
const currentSolarRaw = solarPrimaryReading.value + solarSecondaryReading.value;

let lastReliableDemand = context.get("lastReliableDemand");
if (!Number.isFinite(lastReliableDemand)) {
    lastReliableDemand = Math.max(0, currentDemandRaw);
}
let lastReliableSolar = context.get("lastReliableSolar");
if (!Number.isFinite(lastReliableSolar)) {
    lastReliableSolar = Math.max(0, currentSolarRaw);
}

const demandConfidence = calculateConfidence(
    demandAgeStats,
    timingThresholds,
    currentDemandRaw < 0
);
const solarConfidence = calculateConfidence(solarAgeStats, timingThresholds);

const currentDemandEstimate = Math.max(
    0,
    blendWithFallback(Math.max(0, currentDemandRaw), lastReliableDemand, demandConfidence)
);
const currentSolarEstimate = Math.max(
    0,
    blendWithFallback(currentSolarRaw, lastReliableSolar, solarConfidence)
);

if (demandConfidence >= timingThresholds.reliableConfidence && currentDemandRaw >= 0) {
    lastReliableDemand = currentDemandEstimate;
    context.set("lastReliableDemand", lastReliableDemand);
}
if (solarConfidence >= timingThresholds.reliableConfidence) {
    lastReliableSolar = currentSolarEstimate;
    context.set("lastReliableSolar", lastReliableSolar);
}

// 2. Manage 5-minute history based on the configured trigger interval
let history = context.get("demandHistory") || [];
history.push(currentDemandEstimate);
while (history.length > historySamples) history.shift();
context.set("demandHistory", history);

let solarHistory = context.get("solarHistory") || [];
solarHistory.push(currentSolarEstimate);
while (solarHistory.length > historySamples) solarHistory.shift();
context.set("solarHistory", solarHistory);

// 3. Calculate Average
const averageDemand = average(history);
const averageSolar = average(solarHistory);

// 4. Calculate Median (P50)
const sorted = [...history].sort((a, b) => a - b);
const lowMiddle = Math.floor((sorted.length - 1) / 2);
const highMiddle = Math.ceil((sorted.length - 1) / 2);
const medianDemand = (sorted[lowMiddle] + sorted[highMiddle]) / 2;
const demandLowerBound = percentile(sorted, 0.2);

const longTermMinimumWindowSamples = Math.max(
    1,
    Math.ceil((48 * 60 * 60) / triggerIntervalSeconds)
);
let demandLowerBoundHistory = context.get("demandLowerBoundHistory") || [];
demandLowerBoundHistory.push(demandLowerBound);
while (demandLowerBoundHistory.length > longTermMinimumWindowSamples) {
    demandLowerBoundHistory.shift();
}
context.set("demandLowerBoundHistory", demandLowerBoundHistory);
const demandLongTermMinimum = Math.min(...demandLowerBoundHistory);
const demandStdDev = standardDeviation(history);
const solarStdDev = standardDeviation(solarHistory);
const trendWindowSamples = Math.min(
    history.length,
    Math.max(3, Math.ceil(60 / triggerIntervalSeconds))
);
const demandTrendValues = history.slice(-trendWindowSamples);
const solarTrendValues = solarHistory.slice(-trendWindowSamples);
const demandTrend = calculateTrend(demandTrendValues);
const solarTrend = calculateTrend(solarTrendValues);
const stabilityThresholds = {
    demandStdDev: 80,
    solarStdDev: 120,
    demandTrendDeadband: 15,
    solarTrendDeadband: 20,
    unstableTrendChanges: 2
};
const demandTrendDirection = classifyTrend(demandTrend, stabilityThresholds.demandTrendDeadband);
const solarTrendDirection = classifyTrend(solarTrend, stabilityThresholds.solarTrendDeadband);
const demandTrendChanges = countTrendChanges(
    demandTrendValues,
    stabilityThresholds.demandTrendDeadband
);
const solarTrendChanges = countTrendChanges(
    solarTrendValues,
    stabilityThresholds.solarTrendDeadband
);
const demandStability =
    demandStdDev <= stabilityThresholds.demandStdDev &&
    demandTrendChanges < stabilityThresholds.unstableTrendChanges
        ? "stable"
        : "unstable";
const solarStability =
    solarStdDev <= stabilityThresholds.solarStdDev &&
    solarTrendChanges < stabilityThresholds.unstableTrendChanges
        ? "stable"
        : "unstable";
const stabilityMode =
    demandStability === "stable" && solarStability === "stable"
        ? "stable_stable"
        : demandStability === "unstable" && solarStability === "stable"
          ? "demand_unstable"
          : demandStability === "stable" && solarStability === "unstable"
            ? "solar_unstable"
            : "unstable_unstable";

// 5. ASYMMETRIC LOGIC
const defensiveTarget = Math.min(medianDemand, currentDemandEstimate);
const proactiveSolar = currentSolarEstimate;

// 6. THE "CONTINUOUS FLOW" BIAS
const flowBias = proactiveSolar > 50 ? 20 : 0;
const snapshotLagging =
    currentDemandRaw < 0 ||
    (demandAgeStats.spreadMs !== null &&
        demandAgeStats.spreadMs > timingThresholds.maxSensorSpreadMs) ||
    (demandAgeStats.maxAgeMs !== null && demandAgeStats.maxAgeMs > timingThresholds.maxSensorAgeMs);

node.status({
    fill: snapshotLagging ? "yellow" : "blue",
    shape: snapshotLagging ? "ring" : "dot",
    text: `Solar: ${Math.round(proactiveSolar)}W | Demand: ${Math.round(defensiveTarget)}W | sync ${Math.round(
        demandConfidence * 100
    )}%`
});

msg.derived.demand.current = Math.round(currentDemandEstimate);
msg.derived.demand.raw = Math.round(currentDemandRaw);
msg.derived.demand.average = Math.round(averageDemand);
msg.derived.demand.median = Math.round(medianDemand);
msg.derived.demand.lowerBound = Math.round(demandLowerBound);
msg.derived.demand.longTermMinimum = Math.round(demandLongTermMinimum);
msg.derived.demand.defensiveTarget = Math.round(defensiveTarget - flowBias);
msg.derived.demand.stdDev = Math.round(demandStdDev);
msg.derived.demand.trend = Math.round(demandTrend);
msg.derived.demand.trendDirection = demandTrendDirection;
msg.derived.demand.trendChanges = demandTrendChanges;
msg.derived.solar.livePower = Math.round(proactiveSolar);
msg.derived.solar.rawPower = Math.round(currentSolarRaw);
msg.derived.solar.averagePower = Math.round(averageSolar);
msg.derived.solar.stdDev = Math.round(solarStdDev);
msg.derived.solar.trend = Math.round(solarTrend);
msg.derived.solar.trendDirection = solarTrendDirection;
msg.derived.solar.trendChanges = solarTrendChanges;
msg.meta.sensorTiming = {
    thresholds: timingThresholds,
    demand: {
        confidence: Math.round(demandConfidence * 100) / 100,
        currentRaw: Math.round(currentDemandRaw),
        currentEstimate: Math.round(currentDemandEstimate),
        minAgeMs: demandAgeStats.minAgeMs,
        maxAgeMs: demandAgeStats.maxAgeMs,
        spreadMs: demandAgeStats.spreadMs,
        sensors: {
            grid: gridReading,
            batteryDischarge: batteryDischargeReading,
            solarPrimary: solarPrimaryReading,
            solarSecondary: solarSecondaryReading,
            batteryCharge: batteryChargeReading
        }
    },
    solar: {
        confidence: Math.round(solarConfidence * 100) / 100,
        currentRaw: Math.round(currentSolarRaw),
        currentEstimate: Math.round(currentSolarEstimate),
        minAgeMs: solarAgeStats.minAgeMs,
        maxAgeMs: solarAgeStats.maxAgeMs,
        spreadMs: solarAgeStats.spreadMs,
        sensors: {
            solarPrimary: solarPrimaryReading,
            solarSecondary: solarSecondaryReading
        }
    }
};
msg.meta.stability = {
    mode: stabilityMode,
    demand: demandStability,
    solar: solarStability,
    thresholds: stabilityThresholds,
    stats: {
        demandAverage: Math.round(averageDemand),
        demandLowerBound: Math.round(demandLowerBound),
        demandLongTermMinimum: Math.round(demandLongTermMinimum),
        demandStdDev: Math.round(demandStdDev),
        demandTrend: Math.round(demandTrend),
        demandTrendDirection,
        demandTrendChanges,
        solarAverage: Math.round(averageSolar),
        solarStdDev: Math.round(solarStdDev),
        solarTrend: Math.round(solarTrend),
        solarTrendDirection,
        solarTrendChanges
    }
};
msg.meta.history = {
    windowSeconds: historyWindowSeconds,
    triggerIntervalSeconds: triggerIntervalSeconds,
    triggerIntervalMs: triggerIntervalSeconds * 1000,
    samples: historySamples
};
return msg;
