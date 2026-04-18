function getFirstFinite(values, fallback = 0) {
    for (const value of values) {
        if (Number.isFinite(value)) {
            return value;
        }
    }

    return fallback;
}

const data = msg.data || {};
const chargeAction = msg.action?.charge || {};

const soc = getFirstFinite([data.battery?.soc], 0);
const maxSoc = getFirstFinite([data.battery?.socLimit], 100);
const currentSetInflow = getFirstFinite([data.battery?.chargeSetpoint], 0);
const maxChargeHardware = getFirstFinite(
    [data.battery?.chargeHardwareMaxPower, data.battery?.chargeMaxPower],
    800
);
const gridPower = getFirstFinite([data.grid?.power], 0);

let targetCharge = Math.abs(getFirstFinite([chargeAction.commandPower], 0));
let reason = "Adjusting normally";

if (soc + 1.1 > maxSoc) {
    targetCharge = 0;
    reason = "BATTERY_FULL_OVERFLOW";
} else if (targetCharge > maxChargeHardware) {
    reason = "MAX_CHARGE_OVERFLOW";
}

targetCharge = Math.max(0, Math.min(maxChargeHardware, targetCharge));

const logMsg = {
    payload: {
        time: new Date().toLocaleString("de-DE"),
        grid: gridPower,
        soc: soc,
        targetCharge: Math.round(targetCharge),
        reason: reason
    }
};

let hardwareCmd = null;
if (Math.abs(targetCharge - currentSetInflow) > 10) {
    hardwareCmd = { payload: Math.round(targetCharge) };
} else {
    reason = "No change - no need to adjust";
}

node.status({ fill: "green", shape: "dot", text: `${Math.round(targetCharge)}W (${reason})` });

return [hardwareCmd, { payload: reason }, logMsg];
