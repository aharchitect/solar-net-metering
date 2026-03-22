const map = msg.payload;
const adj = msg.adjustment;

const currentSetLimit = parseFloat(map["number.solarflow_800_pro_output_limit"]?.state) || 0;

// 1. CHOOSE THE TARGET
// We want to reach the 'forcedRate' (to empty the battery),
// OR follow the 'defensiveTarget' (5-min average) if the house is active.
let targetDischarge = adj.command;

// 2. HARDWARE OUTPUT
let hardwareCmd = null;
if (Math.abs(targetDischarge - currentSetLimit) > 5) {
    hardwareCmd = { payload: Math.round(targetDischarge) };
}

node.status({
    fill: "blue",
    shape: adj.nextHourSolar > 50 ? "ring" : "dot",
    text: `target: ${Math.round(targetDischarge)}W`
});

return [hardwareCmd];
