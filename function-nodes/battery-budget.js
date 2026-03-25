const data = msg.data || {};

// 1. DATA EXTRACTION
const availableWh = data.battery?.availableWh || 0;

// 2. NEXT HOUR FORECAST (Wh expected in the next 60 mins)
const totalNextHourWh = data.forecast?.nextHourWh || 0;

// 3. TIME CALCULATION
const now = new Date().getTime();
const sunrise = new Date(data.sun?.nextRising).getTime();

// 4. DYNAMIC WINDOW ADJUSTMENT
let hoursToUsableSolar = Math.max(0.5, (sunrise - now) / (1000 * 60 * 60));

// If the Next Hour forecast is already > 50Wh, the sun is effectively "up"
// for the battery logic, even if the clock says it's early.
if (totalNextHourWh > 100) {
    // Sun is strong! Shorten the window to 1 hour to empty the battery faster.
    hoursToUsableSolar = 1.0;
} else if (totalNextHourWh > 20) {
    // Sun is starting to peek through.
    hoursToUsableSolar = Math.min(hoursToUsableSolar, 2.0);
}

// Handle edge case: If it's 2 AM and sunrise is 6 AM, hoursToSunrise = 4.
// If sunrise has already passed or is invalid, default to a small number to avoid division by zero.
// Calculate hours only if we have a valid date
let hoursToSunrise = 0.5; // Default safety
if (!isNaN(sunrise)) {
    // Math.max ensures we don't get negative numbers if sunrise just happened
    hoursToSunrise = Math.max(0.5, (sunrise - now) / (1000 * 60 * 60));
}

// 3. CALCULATION
const usableWh = Math.max(0, availableWh);
const forcedRate = Math.round(usableWh / hoursToUsableSolar);

// 4. PASS IT FORWARD
msg.derived = msg.derived || {};
msg.derived.forecast = msg.derived.forecast || {};
msg.derived.forecast.nextHourWh = totalNextHourWh;
msg.derived.forecast.hoursToUsableSolar = Math.round(hoursToUsableSolar);
msg.derived.forecast.hoursToSunrise = hoursToSunrise.toFixed(1);
msg.action = msg.action || {};
msg.action.battery = msg.action.battery || {};
msg.action.battery.discharge = msg.action.battery.discharge || {};
msg.action.battery.discharge.forcedRate = forcedRate;

node.status({ fill: "blue", shape: "ring", text: `Budget: forced ${forcedRate}W until sunrise` });

return msg;
