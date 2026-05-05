// 1. Calculate current real house demand
const map = msg.payload || {};
const now = Date.now();

// INITIALIZATION: Ensure buckets exist so we don't crash
if (!msg.adjustment) {
    msg.adjustment = {};
}
if (!msg.meta) {
    msg.meta = {};
}

function getEntity(entityId) {
    return map[entityId];
}

function getEntityTimeInfo(entity) {
    const candidates = [
        ["last_reported", entity?.last_reported],
        ["last_updated", entity?.last_updated],
        ["last_changed", entity?.last_changed],
        ["attributes.last_reported", entity?.attributes?.last_reported],
        ["attributes.last_updated", entity?.attributes?.last_updated],
        ["attributes.last_changed", entity?.attributes?.last_changed]
    ];

    for (const [source, rawTimestamp] of candidates) {
        if (!rawTimestamp) {
            continue;
        }

        const timestampMs = new Date(rawTimestamp).getTime();
        if (Number.isFinite(timestampMs)) {
            return {
                timestamp: String(rawTimestamp),
                timestampMs,
                ageMs: Math.max(0, now - timestampMs),
                source
            };
        }
    }

    return {
        timestamp: null,
        timestampMs: null,
        ageMs: null,
        source: null
    };
}

function readSensor(entityId) {
    const entity = getEntity(entityId);
    const parsedValue = parseFloat(entity?.state);
    const timeInfo = getEntityTimeInfo(entity);

    return {
        entityId,
        rawState: entity?.state ?? null,
        value: Number.isFinite(parsedValue) ? parsedValue : 0,
        isValid: Number.isFinite(parsedValue),
        timestamp: timeInfo.timestamp,
        timestampMs: timeInfo.timestampMs,
        ageMs: timeInfo.ageMs,
        timestampSource: timeInfo.source
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

const triggerIntervalSeconds =
    msg.meta?.trigger?.intervalSeconds || flow.get("triggerIntervalSeconds") || 20;
const historyWindowSeconds = 5 * 60;
const historySamples = Math.max(15, Math.ceil(historyWindowSeconds / triggerIntervalSeconds));
const timingThresholds = {
    maxSensorAgeMs: Math.max(45 * 1000, triggerIntervalSeconds * 4 * 1000),
    maxSensorSpreadMs: Math.max(25 * 1000, Math.round(triggerIntervalSeconds * 2.5 * 1000)),
    reliableConfidence: 0.7
};

const gridReading = readSensor("sensor.smartmeter_keller_sml_watt_summe");
const batteryDischargeReading = readSensor("sensor.solarflow_800_pro_output_home_power");
const solarPrimaryReading = readSensor("sensor.wechselrichter_ac_leistung");
const solarSecondaryReading = readSensor("sensor.hoymiles600_power");
const batteryChargeReading = readSensor("sensor.solarflow_800_pro_grid_input_power");

const demandTimingReadings = [
    gridReading,
    batteryDischargeReading,
    solarPrimaryReading,
    solarSecondaryReading,
    batteryChargeReading
];
const solarTimingReadings = [solarPrimaryReading, solarSecondaryReading];
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
const averageSolar =
    solarHistory.reduce((sum, value) => sum + value, 0) / Math.max(1, solarHistory.length);

// 4. Calculate Median (P50)
const sorted = [...history].sort((a, b) => a - b);
const lowMiddle = Math.floor((sorted.length - 1) / 2);
const highMiddle = Math.ceil((sorted.length - 1) / 2);
const medianDemand = (sorted[lowMiddle] + sorted[highMiddle]) / 2;

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

msg.adjustment.defensiveTarget = Math.round(defensiveTarget - flowBias);
msg.adjustment.currentDemandRaw = Math.round(currentDemandRaw);
msg.adjustment.currentDemandEstimate = Math.round(currentDemandEstimate);
msg.adjustment.demandConfidence = Math.round(demandConfidence * 100) / 100;
msg.adjustment.solarPower = Math.round(proactiveSolar);
msg.adjustment.solarRawPower = Math.round(currentSolarRaw);
msg.adjustment.solarConfidence = Math.round(solarConfidence * 100) / 100;
msg.adjustment.solarAveragePower = Math.round(averageSolar);
msg.adjustment.sensorTiming = {
    demandAgeSpreadMs: demandAgeStats.spreadMs,
    demandMaxAgeMs: demandAgeStats.maxAgeMs,
    solarAgeSpreadMs: solarAgeStats.spreadMs,
    solarMaxAgeMs: solarAgeStats.maxAgeMs,
    snapshotLagging
};
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
msg.meta.history = {
    windowSeconds: historyWindowSeconds,
    triggerIntervalSeconds: triggerIntervalSeconds,
    triggerIntervalMs: triggerIntervalSeconds * 1000,
    samples: historySamples
};
return msg;
