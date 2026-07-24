function getFirstFinite(values, fallback = 0) {
    for (const value of values) {
        if (Number.isFinite(value)) {
            return value;
        }
    }

    return fallback;
}

const desiredDischarge = Math.max(0, Math.round(getFirstFinite([msg.payload], 0)));
const currentMode = String(msg.data?.inverter?.acMode || "").toLowerCase();
const currentOutputLimit = Math.max(0, getFirstFinite([msg.data?.battery?.dischargeSetpoint], 0));
const currentInputLimit = Math.max(0, getFirstFinite([msg.data?.battery?.chargeSetpoint], 0));

// Keep every actuator idempotent.  A previous charge cycle may have left the
// input limit or AC mode active, but we must not re-send an already matching
// value on every discharge-controller cycle.
const dischargeChangeRequired = Math.abs(desiredDischarge - currentOutputLimit) > 5;
const modeChangeRequired = currentMode !== "output";
const inputLimitChangeRequired = currentInputLimit > 5;

if (!dischargeChangeRequired && !modeChangeRequired && !inputLimitChangeRequired) {
    node.status({
        fill: "grey",
        shape: "ring",
        text: `discharge ${Math.round(currentOutputLimit)}W, output mode, input off`
    });
    return null;
}

const pendingActions = [];
if (dischargeChangeRequired) pendingActions.push(`discharge ${desiredDischarge}W`);
if (modeChangeRequired) pendingActions.push(`mode ${currentMode || "unknown"}->output`);
if (inputLimitChangeRequired) pendingActions.push(`input ${Math.round(currentInputLimit)}W->0`);

node.status({
    fill: "blue",
    shape: "dot",
    text: pendingActions.join(" | ")
});

return [
    dischargeChangeRequired ? msg : null,
    modeChangeRequired ? msg : null,
    inputLimitChangeRequired ? msg : null
];
