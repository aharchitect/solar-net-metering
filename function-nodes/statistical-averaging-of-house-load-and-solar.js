// 1. Calculate current real house demand from normalized inputs
const data = msg.data || {};
if (!msg.meta) {
    msg.meta = {};
}
if (!msg.derived) {
    msg.derived = {};
}

const grid = data.grid?.power || 0;
const batOut = data.battery?.dischargePower || 0;
const solarIn1 = data.solar?.primaryPower || 0;
const solarIn2 = data.solar?.secondaryPower || 0;
const batIn = data.battery?.chargePower || 0;
const currentDemand = data.house?.demandPower || grid + batOut + solarIn1 + solarIn2 - batIn;
const currentSolarPower = data.solar?.totalPower || solarIn1 + solarIn2;

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

const demandStdDevThreshold = 60;
const solarStdDevThreshold = 80;
const demandStable = demandStdDev <= demandStdDevThreshold;
const solarStable = solarStdDev <= solarStdDevThreshold;
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
    stdDev: Math.round(demandStdDev)
};
msg.derived.solar = {
    livePower: Math.round(proactiveSolar),
    averagePower: Math.round(averageSolar),
    stdDev: Math.round(solarStdDev)
};
msg.meta.history = {
    windowSeconds: historyWindowSeconds,
    triggerIntervalSeconds: triggerIntervalSeconds,
    triggerIntervalMs: triggerIntervalSeconds * 1000,
    samples: historySamples
};
msg.meta.stability = {
    mode: stabilityMode,
    demand: demandStable ? "stable" : "unstable",
    solar: solarStable ? "stable" : "unstable",
    thresholds: {
        demandStdDev: demandStdDevThreshold,
        solarStdDev: solarStdDevThreshold
    },
    stats: {
        demandAverage: Math.round(averageDemand),
        demandStdDev: Math.round(demandStdDev),
        solarAverage: Math.round(averageSolar),
        solarStdDev: Math.round(solarStdDev)
    }
};
return msg;
