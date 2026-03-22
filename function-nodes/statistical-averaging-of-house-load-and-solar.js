// 1. Calculate current real house demand
const map = msg.payload;
// INITIALIZATION: Ensure msg.adjustment exists so we don't crash
if (!msg.adjustment) {
    msg.adjustment = {};
}
if (!msg.meta) {
    msg.meta = {};
}

const grid = parseFloat(map["sensor.smartmeter_keller_sml_watt_summe"]?.state) || 0;
const batOut = parseFloat(map["sensor.solarflow_800_pro_output_home_power"]?.state) || 0;
const solarIn1 = parseFloat(map["sensor.wechselrichter_ac_leistung"]?.state) || 0;
const solarIn2 = parseFloat(map["sensor.hoymiles600_power"]?.state) || 0;
const batIn = parseFloat(map["sensor.solarflow_800_pro_grid_input_power"]?.state) || 0;
const currentDemand = grid + batOut + solarIn1 + solarIn2 - batIn;
const currentSolarPower = solarIn1 + solarIn2;

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
const averageSolar = solarHistory.reduce((c, d) => c + d, 0) / solarHistory.length;
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
    text: `Solar (Now): ${Math.round(proactiveSolar)}W, (5min avg): ${Math.round(averageSolar)}W | Demand (Def): ${Math.round(defensiveTarget)}W, n=${historySamples}`
});

msg.adjustment.defensiveTarget = Math.round(defensiveTarget - flowBias);
msg.adjustment.solarPower = Math.round(proactiveSolar);
msg.adjustment.solarAveragePower = Math.round(averageSolar);
msg.meta.history = {
    windowSeconds: historyWindowSeconds,
    triggerIntervalSeconds: triggerIntervalSeconds,
    triggerIntervalMs: triggerIntervalSeconds * 1000,
    samples: historySamples
};
return msg;
