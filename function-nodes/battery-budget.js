const map = msg.payload;

// 1. DATA EXTRACTION
const availableWh = (parseFloat(map["sensor.solarflow_800_pro_available_kwh"]?.state) || 0) * 1000;

// 2. NEXT HOUR FORECAST (Wh expected in the next 60 mins)
const nextH1 = parseFloat(map["sensor.energy_next_hour"]?.state) || 0;
const nextH2 = parseFloat(map["sensor.energy_next_hour_2"]?.state) || 0;
const totalNextHourWh = nextH1 + nextH2;

// 3. TIME CALCULATION
const now = new Date().getTime();
const sunrise = new Date(map["sun.sun"]?.attributes?.next_rising).getTime();

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
msg.adjustment.forcedRate = forcedRate;
msg.adjustment.hoursToSunrise = hoursToSunrise.toFixed(1);
msg.adjustment.nextHourSolar = totalNextHourWh;

node.status({ fill: "blue", shape: "ring", text: `Budget: forced ${forcedRate}W until sunrise` });

return msg;
