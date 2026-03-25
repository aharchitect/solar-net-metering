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

if (abortForMissing(["data.house.demandPower", "data.solar.totalPower"])) {
    return null;
}

// 1. Calculate current real house demand from normalized inputs
const data = msg.data;
if (!msg.meta) {
    msg.meta = {};
}
if (!msg.derived) {
    msg.derived = {};
}

const currentDemand = data.house.demandPower;
const currentSolarPower = data.solar.totalPower;

function calculateAverage(values) {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function calculateStdDev(values, average) {
    if (values.length <= 1) {
        return 0;
    }

    const variance =
        values.reduce((sum, value) => sum + Math.pow(value - average, 2), 0) / values.length;
    return Math.sqrt(variance);
}

function calculateTrend(values) {
    if (values.length < 4) {
        return 0;
    }

    const segmentSize = Math.max(2, Math.floor(values.length / 2));
    const earlierSegment = values.slice(0, values.length - segmentSize);
    const recentSegment = values.slice(-segmentSize);

    if (earlierSegment.length === 0 || recentSegment.length === 0) {
        return 0;
    }

    return calculateAverage(recentSegment) - calculateAverage(earlierSegment);
}

function calculateTrendDirection(trendValue, deadband) {
    if (trendValue > deadband) {
        return "up";
    }
    if (trendValue < -deadband) {
        return "down";
    }
    return "flat";
}

function countTrendDirectionChanges(directions) {
    let lastDirection = null;
    let changes = 0;

    for (const direction of directions) {
        if (direction === "flat") {
            continue;
        }
        if (lastDirection && direction !== lastDirection) {
            changes += 1;
        }
        lastDirection = direction;
    }

    return changes;
}

// 2. Manage 5-minute history based on the configured trigger interval
const historyWindowSeconds = 5 * 60;
const triggerIntervalSeconds =
    msg.meta?.trigger?.intervalSeconds || flow.get("triggerIntervalSeconds") || 20;
const historySamples = Math.max(15, Math.ceil(historyWindowSeconds / triggerIntervalSeconds));

let history = context.get("demandHistory") || [];
history.push(currentDemand);
while (history.length > historySamples) history.shift();
context.set("demandHistory", history);

let solarHistory = context.get("solarHistory") || [];
solarHistory.push(currentSolarPower);
while (solarHistory.length > historySamples) solarHistory.shift();
context.set("solarHistory", solarHistory);

// 3. Calculate Average
const averageDemand = calculateAverage(history);
const averageSolar = calculateAverage(solarHistory);
const demandStdDev = calculateStdDev(history, averageDemand);
const solarStdDev = calculateStdDev(solarHistory, averageSolar);
const demandTrend = calculateTrend(history);
const solarTrend = calculateTrend(solarHistory);
const trendWindowSeconds = 120;
const trendHistorySamples = Math.max(3, Math.ceil(trendWindowSeconds / triggerIntervalSeconds));
const demandTrendDeadband = 15;
const solarTrendDeadband = 25;
const unstableTrendChangesThreshold = 2;

const demandTrendDirection = calculateTrendDirection(demandTrend, demandTrendDeadband);
const solarTrendDirection = calculateTrendDirection(solarTrend, solarTrendDeadband);

let demandTrendHistory = context.get("demandTrendHistory") || [];
demandTrendHistory.push(demandTrendDirection);
while (demandTrendHistory.length > trendHistorySamples) demandTrendHistory.shift();
context.set("demandTrendHistory", demandTrendHistory);

let solarTrendHistory = context.get("solarTrendHistory") || [];
solarTrendHistory.push(solarTrendDirection);
while (solarTrendHistory.length > trendHistorySamples) solarTrendHistory.shift();
context.set("solarTrendHistory", solarTrendHistory);

const demandTrendChanges = countTrendDirectionChanges(demandTrendHistory);
const solarTrendChanges = countTrendDirectionChanges(solarTrendHistory);
const demandTrendIsChaotic = demandTrendChanges >= unstableTrendChangesThreshold;
const solarTrendIsChaotic = solarTrendChanges >= unstableTrendChangesThreshold;

const demandStdDevThreshold = 60;
const solarStdDevThreshold = 80;
const demandStable = demandStdDev <= demandStdDevThreshold && !demandTrendIsChaotic;
const solarStable = solarStdDev <= solarStdDevThreshold && !solarTrendIsChaotic;
const stabilityMode = solarStable
    ? demandStable
        ? "stable_stable"
        : "demand_unstable"
    : demandStable
      ? "solar_unstable"
      : "unstable_unstable";

// 4. Calculate Median (P50)
// We create a copy so we don't mess up the chronological history
const sorted = [...history].sort((a, b) => a - b);
const lowMiddle = Math.floor((sorted.length - 1) / 2);
const highMiddle = Math.ceil((sorted.length - 1) / 2);
const medianDemand = (sorted[lowMiddle] + sorted[highMiddle]) / 2;

// 5. ASYMMETRIC LOGIC
// Demand: Use the Median/Defensive approach (STAY SLOW)
// This prevents the battery from discharging too fast when a spike is brief.
const defensiveTarget = Math.min(medianDemand, currentDemand);

// Solar: Keep the live value for quick visibility, but also publish the
// rolling 5-minute average so the charge controller can make steadier decisions.
const proactiveSolar = currentSolarPower;

// 6. THE "CONTINUOUS FLOW" BIAS
// If there is any solar production (>50W), we artificially lower the
// defensive demand slightly to ensure the calculation always results
// in a small positive "surplus" for the battery.
const flowBias = proactiveSolar > 50 ? 20 : 0;

node.status({
    fill: "blue",
    shape: "dot",
    text: `Mode: ${stabilityMode} | Solar (Now): ${Math.round(proactiveSolar)}W, (5min avg): ${Math.round(averageSolar)}W | Demand (Def): ${Math.round(defensiveTarget)}W`
});

msg.derived.demand = {
    current: Math.round(currentDemand),
    average: Math.round(averageDemand),
    median: Math.round(medianDemand),
    defensiveTarget: Math.round(defensiveTarget - flowBias),
    stdDev: Math.round(demandStdDev),
    trend: Math.round(demandTrend),
    trendDirection: demandTrendDirection,
    trendChanges: demandTrendChanges
};
msg.derived.solar = {
    livePower: Math.round(proactiveSolar),
    averagePower: Math.round(averageSolar),
    stdDev: Math.round(solarStdDev),
    trend: Math.round(solarTrend),
    trendDirection: solarTrendDirection,
    trendChanges: solarTrendChanges
};
msg.meta.history = {
    windowSeconds: historyWindowSeconds,
    triggerIntervalSeconds: triggerIntervalSeconds,
    triggerIntervalMs: triggerIntervalSeconds * 1000,
    samples: historySamples,
    trendWindowSeconds: trendWindowSeconds,
    trendSamples: trendHistorySamples
};
msg.meta.stability = {
    mode: stabilityMode,
    demand: demandStable ? "stable" : "unstable",
    solar: solarStable ? "stable" : "unstable",
    thresholds: {
        demandStdDev: demandStdDevThreshold,
        solarStdDev: solarStdDevThreshold,
        demandTrendDeadband: demandTrendDeadband,
        solarTrendDeadband: solarTrendDeadband,
        unstableTrendChanges: unstableTrendChangesThreshold
    },
    stats: {
        demandAverage: Math.round(averageDemand),
        demandStdDev: Math.round(demandStdDev),
        demandTrend: Math.round(demandTrend),
        demandTrendDirection: demandTrendDirection,
        demandTrendChanges: demandTrendChanges,
        solarAverage: Math.round(averageSolar),
        solarStdDev: Math.round(solarStdDev),
        solarTrend: Math.round(solarTrend),
        solarTrendDirection: solarTrendDirection,
        solarTrendChanges: solarTrendChanges
    }
};
return msg;
