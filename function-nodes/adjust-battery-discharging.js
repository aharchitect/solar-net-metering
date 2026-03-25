const data = msg.data || {};
const action = msg.action || {};

const currentSetLimit = data.battery?.dischargeSetpoint || 0;

// 1. CHOOSE THE TARGET
// We want to reach the 'forcedRate' (to empty the battery),
// OR follow the 'defensiveTarget' (5-min average) if the house is active.
let targetDischarge = action.battery?.discharge?.commandPower || 0;
const nextHourWh = data.forecast?.nextHourWh || 0;

// 2. HARDWARE OUTPUT
let hardwareCmd = null;
if (Math.abs(targetDischarge - currentSetLimit) > 5) {
    hardwareCmd = { payload: Math.round(targetDischarge) };
}

node.status({
    fill: "blue",
    shape: nextHourWh > 50 ? "ring" : "dot",
    text: `target: ${Math.round(targetDischarge)}W`
});

return [hardwareCmd];
