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
    return current !== undefined && current !== null;
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

function parseTimestampMs(value) {
    if (typeof value !== "string" || value.trim() === "") {
        return null;
    }

    const timestampMs = new Date(value).getTime();
    return Number.isFinite(timestampMs) ? timestampMs : null;
}

if (
    abortForMissing(["data.battery.availableWh", "data.forecast.nextHourWh", "data.sun.nextRising"])
) {
    return null;
}

const data = msg.data;

// 1. DATA EXTRACTION
const availableWh = data.battery.availableWh;

// 2. NEXT HOUR FORECAST (Wh expected in the next 60 mins)
const totalNextHourWh = data.forecast.nextHourWh;

// 3. TIME CALCULATION
const now = new Date().getTime();
const sunrise = parseTimestampMs(data.sun.nextRising);

if (sunrise === null) {
    const errorMessage = `Invalid sunrise timestamp: ${data.sun.nextRising}`;
    node.status({ fill: "red", shape: "ring", text: "Invalid sunrise timestamp" });
    node.error(errorMessage, msg);
    return null;
}

// 4. DYNAMIC WINDOW ADJUSTMENT
let hoursToUsableSolar = Math.max(0.5, (sunrise - now) / (1000 * 60 * 60));
let budgetWindowReason = "sunrise";

// If the Next Hour forecast is already > 100Wh, the sun is effectively "up"
// for the battery logic, even if the clock says it's early.
if (totalNextHourWh > 100) {
    // Sun is strong! Shorten the window to 1 hour to empty the battery faster.
    hoursToUsableSolar = 1.0;
    budgetWindowReason = "usable solar";
} else if (totalNextHourWh > 20) {
    // Sun is starting to peek through.
    hoursToUsableSolar = Math.min(hoursToUsableSolar, 2.0);
    budgetWindowReason = hoursToUsableSolar === 2.0 ? "early solar" : "sunrise";
}

// Handle edge case: If it's 2 AM and sunrise is 6 AM, hoursToSunrise = 4.
// If sunrise has already passed, default to a small number to avoid division by zero.
// Math.max ensures we don't get negative numbers if sunrise just happened.
const hoursToSunrise = Math.max(0.5, (sunrise - now) / (1000 * 60 * 60));

// 3. CALCULATION
const usableWh = Math.max(0, availableWh);
const forcedRate = Math.round(usableWh / hoursToUsableSolar);

// 4. PASS IT FORWARD
msg.derived = msg.derived || {};
msg.derived.forecast = msg.derived.forecast || {};
msg.derived.forecast.nextHourWh = totalNextHourWh;
msg.derived.forecast.hoursToUsableSolar = Number(hoursToUsableSolar.toFixed(1));
msg.derived.forecast.hoursToSunrise = hoursToSunrise.toFixed(1);
msg.derived.forecast.budgetWindowReason = budgetWindowReason;
msg.action = msg.action || {};
msg.action.battery = msg.action.battery || {};
msg.action.battery.discharge = msg.action.battery.discharge || {};
msg.action.battery.discharge.forcedRate = forcedRate;

node.status({
    fill: "blue",
    shape: "ring",
    text: `Budget: forced ${forcedRate}W over ${hoursToUsableSolar.toFixed(1)}h (${budgetWindowReason})`
});

return msg;
