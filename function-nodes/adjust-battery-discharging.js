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

if (
    abortForMissing([
        "data.battery.dischargeSetpoint",
        "data.forecast.nextHourWh",
        "action.battery.discharge.commandPower"
    ])
) {
    return null;
}

const data = msg.data;
const action = msg.action;

const currentSetLimit = data.battery.dischargeSetpoint;

// 1. CHOOSE THE TARGET
// We want to reach the 'forcedRate' (to empty the battery),
// OR follow the 'defensiveTarget' (5-min average) if the house is active.
let targetDischarge = action.battery.discharge.commandPower;
const nextHourWh = data.forecast.nextHourWh;

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
