function getFirstFinite(values, fallback = 0) {
    for (const value of values) {
        if (Number.isFinite(value)) {
            return value;
        }
    }

    return fallback;
}

const desiredCharge = Math.max(0, Math.round(getFirstFinite([msg.payload], 0)));
const currentMode = String(msg.data?.inverter?.acMode || "").toLowerCase();
const currentOutputLimit = Math.max(0, getFirstFinite([msg.data?.battery?.dischargeSetpoint], 0));
const currentInputLimit = Math.max(0, getFirstFinite([msg.data?.battery?.chargeSetpoint], 0));

// The Zendure integration can reset limits while changing AC mode.  Check
// every actuator independently: a previous discharge may have left either
// output mode or output power active, while a changed charge request still
// needs to pass through.  Do not re-send a value that already matches.
const chargeChangeRequired = Math.abs(desiredCharge - currentInputLimit) > 5;
const modeChangeRequired = currentMode !== "input";
const outputLimitChangeRequired = currentOutputLimit > 0;

if (!chargeChangeRequired && !modeChangeRequired && !outputLimitChangeRequired) {
    node.status({
        fill: "grey",
        shape: "ring",
        text: `charge ${Math.round(currentInputLimit)}W, input mode, output off`
    });
    return null;
}

const pendingActions = [];
if (chargeChangeRequired) pendingActions.push(`charge ${desiredCharge}W`);
if (modeChangeRequired) pendingActions.push(`mode ${currentMode || "unknown"}->input`);
if (outputLimitChangeRequired) pendingActions.push(`output ${Math.round(currentOutputLimit)}W->0`);

node.status({
    fill: "blue",
    shape: "dot",
    text: pendingActions.join(" | ")
});

return [
    chargeChangeRequired ? msg : null,
    modeChangeRequired ? msg : null,
    outputLimitChangeRequired ? msg : null
];
