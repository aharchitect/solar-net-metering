// Specification:
// Encapsulate Home Assistant entity ids in one place and expose a semantic,
// reusable internal message structure for all subsequent controller nodes.
const ha = msg.payload || {};
const now = Date.now();
const triggerIntervalSeconds =
    msg.meta?.trigger?.intervalSeconds || flow.get("triggerIntervalSeconds") || 20;
const retainedReadingMs = Math.max(60 * 1000, triggerIntervalSeconds * 6 * 1000);
const configuredMinimumHouseDemandW = parseFloat(flow.get("minimumHouseDemandW"));
const minimumHouseDemandW = Number.isFinite(configuredMinimumHouseDemandW)
    ? configuredMinimumHouseDemandW
    : 40;
const plausibilityThresholds = {
    maxSensorAgeMs: Math.max(20 * 1000, triggerIntervalSeconds * 2 * 1000),
    maxSensorSpreadMs: Math.max(20 * 1000, triggerIntervalSeconds * 2 * 1000),
    minimumHouseDemandW: minimumHouseDemandW,
    setpointToleranceW: Math.max(40, minimumHouseDemandW)
};
let lastValidNumbers = context.get("lastValidNumbers") || {};

function getEntity(entityId) {
    return ha[entityId];
}

function getEntityTimeInfo(entity) {
    const candidates = [
        ["last_reported", entity?.last_reported],
        ["last_updated", entity?.last_updated],
        ["last_changed", entity?.last_changed],
        ["attributes.last_reported", entity?.attributes?.last_reported],
        ["attributes.last_updated", entity?.attributes?.last_updated],
        ["attributes.last_changed", entity?.attributes?.last_changed]
    ];

    for (const [source, rawTimestamp] of candidates) {
        if (!rawTimestamp) {
            continue;
        }

        const timestampMs = new Date(rawTimestamp).getTime();
        if (Number.isFinite(timestampMs)) {
            return {
                timestamp: String(rawTimestamp),
                timestampMs,
                ageMs: Math.max(0, now - timestampMs),
                source
            };
        }
    }

    return {
        timestamp: null,
        timestampMs: null,
        ageMs: null,
        source: null
    };
}

function readNumber(entityId, fallback = 0, options = {}) {
    const { remember = false, maxAgeMs = retainedReadingMs } = options;
    const entity = getEntity(entityId);
    const rawState = entity?.state ?? null;
    const parsedValue = parseFloat(rawState);
    const isValid = Number.isFinite(parsedValue);
    const timeInfo = getEntityTimeInfo(entity);
    let value = fallback;
    let usedLastValid = false;
    let lastValidAgeMs = null;

    if (isValid) {
        value = parsedValue;
        if (remember) {
            lastValidNumbers[entityId] = {
                value: parsedValue,
                timestamp: now
            };
        }
    } else if (remember) {
        const cached = lastValidNumbers[entityId];
        if (cached) {
            lastValidAgeMs = now - cached.timestamp;
            if (lastValidAgeMs <= maxAgeMs) {
                value = cached.value;
                usedLastValid = true;
            }
        }
    }

    return {
        entityId,
        rawState,
        parsedValue: isValid ? parsedValue : null,
        value,
        isValid,
        sourceTimestamp: timeInfo.timestamp,
        sourceTimestampMs: timeInfo.timestampMs,
        sourceAgeMs: timeInfo.ageMs,
        sourceTimestampField: timeInfo.source,
        usedLastValid,
        usedFallback: !isValid && !usedLastValid,
        lastValidAgeMs
    };
}

function getNumber(entityId, fallback = 0, options = {}) {
    return readNumber(entityId, fallback, options).value;
}

function getString(entityId, fallback = "") {
    const value = getEntity(entityId)?.state;
    return value !== undefined && value !== null ? String(value) : fallback;
}

function readWh(entityId, fallback = 0, options = {}) {
    const { remember = false, maxAgeMs = retainedReadingMs } = options;
    const entity = getEntity(entityId);
    const rawState = entity?.state ?? null;
    const parsedValue = parseFloat(rawState);
    const isValid = Number.isFinite(parsedValue);
    const timeInfo = getEntityTimeInfo(entity);
    const unit = entity?.attributes?.unit_of_measurement;
    let value = fallback;
    let usedLastValid = false;
    let lastValidAgeMs = null;

    if (isValid) {
        value = unit === "kWh" ? parsedValue * 1000 : parsedValue;
        if (remember) {
            lastValidNumbers[entityId] = {
                value,
                timestamp: now
            };
        }
    } else if (remember) {
        const cached = lastValidNumbers[entityId];
        if (cached) {
            lastValidAgeMs = now - cached.timestamp;
            if (lastValidAgeMs <= maxAgeMs) {
                value = cached.value;
                usedLastValid = true;
            }
        }
    }

    return {
        entityId,
        rawState,
        parsedValue: isValid ? value : null,
        value,
        isValid,
        sourceTimestamp: timeInfo.timestamp,
        sourceTimestampMs: timeInfo.timestampMs,
        sourceAgeMs: timeInfo.ageMs,
        sourceTimestampField: timeInfo.source,
        usedLastValid,
        usedFallback: !isValid && !usedLastValid,
        lastValidAgeMs
    };
}

function summarizeReading(reading) {
    return {
        entityId: reading.entityId,
        rawState: reading.rawState,
        parsedValue: reading.parsedValue,
        value: reading.value,
        isValid: reading.isValid,
        sourceTimestamp: reading.sourceTimestamp,
        sourceTimestampMs: reading.sourceTimestampMs,
        sourceAgeMs: reading.sourceAgeMs,
        sourceTimestampField: reading.sourceTimestampField,
        isStale: reading.isStale,
        staleAgeThresholdMs: reading.staleAgeThresholdMs,
        usedLastValid: reading.usedLastValid,
        usedFallback: reading.usedFallback,
        lastValidAgeMs: reading.lastValidAgeMs
    };
}

function addStaleness(reading) {
    return {
        ...reading,
        isStale:
            reading.isValid &&
            Number.isFinite(reading.sourceAgeMs) &&
            reading.sourceAgeMs >= plausibilityThresholds.maxSensorAgeMs,
        staleAgeThresholdMs: plausibilityThresholds.maxSensorAgeMs
    };
}

function buildAgeStats(readings) {
    const ages = readings.map((reading) => reading.sourceAgeMs).filter(Number.isFinite);
    if (ages.length === 0) {
        return {
            minAgeMs: null,
            maxAgeMs: null,
            spreadMs: null
        };
    }

    const minAgeMs = Math.min(...ages);
    const maxAgeMs = Math.max(...ages);

    return {
        minAgeMs,
        maxAgeMs,
        spreadMs: maxAgeMs - minAgeMs
    };
}

const gridPowerReading = addStaleness(
    readNumber("sensor.smartmeter_keller_sml_watt_summe", 0, {
        remember: true
    })
);
const solarPrimaryPowerReading = addStaleness(
    readNumber("sensor.wechselrichter_ac_leistung", 0, {
        remember: true
    })
);
const solarSecondaryPowerReading = addStaleness(
    readNumber("sensor.hoymiles600_power", 0, {
        remember: true
    })
);
const batteryChargePowerReading = addStaleness(
    readNumber("sensor.solarflow_800_pro_grid_input_power", 0, {
        remember: true
    })
);
const batteryDischargePowerReading = addStaleness(
    readNumber("sensor.solarflow_800_pro_output_home_power", 0, {
        remember: true
    })
);

const demandComponentReadings = [
    { key: "grid", label: "gridPower", reading: gridPowerReading, sign: 1 },
    {
        key: "batteryDischarge",
        label: "batteryDischargePower",
        reading: batteryDischargePowerReading,
        sign: 1
    },
    { key: "solarPrimary", label: "solarPrimaryPower", reading: solarPrimaryPowerReading, sign: 1 },
    {
        key: "solarSecondary",
        label: "solarSecondaryPower",
        reading: solarSecondaryPowerReading,
        sign: 1
    },
    {
        key: "batteryCharge",
        label: "batteryChargePower",
        reading: batteryChargePowerReading,
        sign: -1
    }
];

const demandPowerRaw = demandComponentReadings.reduce(
    (sum, component) => sum + component.reading.value * component.sign,
    0
);
const demandPowerZeroFallback = demandComponentReadings.reduce((sum, component) => {
    const readingValue = component.reading.isValid ? component.reading.parsedValue : 0;
    return sum + readingValue * component.sign;
}, 0);
const demandInvalidInputs = demandComponentReadings
    .filter((component) => !component.reading.isValid)
    .map((component) => component.label);
const sunAboveHorizon = getString("sun.sun") === "above_horizon";
const sunNextRising = getEntity("sun.sun")?.attributes?.next_rising || null;
const demandPlausibilityComponents = demandComponentReadings.filter((component) => {
    const isIdleNightSolar =
        !sunAboveHorizon &&
        (component.key === "solarPrimary" || component.key === "solarSecondary") &&
        component.reading.value === 0;

    return !isIdleNightSolar;
});
const demandRetainedInputs = demandComponentReadings
    .filter((component) => component.reading.usedLastValid)
    .map((component) => component.label);
const demandStaleInputs = demandPlausibilityComponents
    .filter((component) => component.reading.isStale)
    .map((component) => component.label);
const demandAgeStats = buildAgeStats(
    demandPlausibilityComponents.map((component) => component.reading)
);
const demandPower = Math.max(0, demandPowerRaw);
const demandPowerClamped = demandPowerRaw < 0;

if (!msg.derived) {
    msg.derived = {};
}
if (!msg.action) {
    msg.action = {};
}
if (!msg.meta) {
    msg.meta = {};
}

const solarRemainingWhPrimaryReading = readWh("sensor.energy_production_today_remaining", 0, {
    remember: true
});
const solarRemainingWhSecondaryReading = readWh("sensor.energy_production_today_remaining_2", 0, {
    remember: true
});
const nextHourPrimaryReading = readNumber("sensor.energy_next_hour", 0, { remember: true });
const nextHourSecondaryReading = readNumber("sensor.energy_next_hour_2", 0, { remember: true });
const batteryChargeSetpoint = getNumber("number.solarflow_800_pro_input_limit", 0, {
    remember: true
});
const batteryDischargeSetpoint = getNumber("number.solarflow_800_pro_output_limit", 0, {
    remember: true
});
const batteryChargeMaxPower = getNumber("sensor.solarflow_800_pro_charge_max_limit", 800, {
    remember: true
});
const batteryChargeHardwareMaxPower = getNumber("sensor.solarflow_800_pro_charge_max_limit", 800, {
    remember: true
});
const chargeSetpointMismatch =
    batteryChargePowerReading.isStale &&
    batteryChargeSetpoint >
        batteryChargePowerReading.value + plausibilityThresholds.setpointToleranceW;
const dischargeSetpointMismatch =
    batteryDischargePowerReading.isStale &&
    batteryDischargeSetpoint >
        batteryDischargePowerReading.value + plausibilityThresholds.setpointToleranceW;
const demandTimingSpreadExceeded =
    Number.isFinite(demandAgeStats.spreadMs) &&
    demandAgeStats.spreadMs >= plausibilityThresholds.maxSensorSpreadMs;
const demandBelowMinimumExpected =
    demandPowerRaw >= 0 && demandPowerRaw < plausibilityThresholds.minimumHouseDemandW;
const demandPlausibilityIssues = [];
const demandPlausibilityDetails = [];

if (demandInvalidInputs.length > 0) {
    demandPlausibilityIssues.push("invalid_inputs");
    demandPlausibilityDetails.push(`invalid ${demandInvalidInputs.join(",")}`);
}
if (demandRetainedInputs.length > 0) {
    demandPlausibilityIssues.push("retained_inputs");
    demandPlausibilityDetails.push(`retained ${demandRetainedInputs.join(",")}`);
}
if (demandStaleInputs.length > 0) {
    demandPlausibilityIssues.push("stale_inputs");
    demandPlausibilityDetails.push(`stale ${demandStaleInputs.join(",")}`);
}
if (demandTimingSpreadExceeded) {
    demandPlausibilityIssues.push("timing_spread");
    demandPlausibilityDetails.push(`age spread ${Math.round(demandAgeStats.spreadMs)}ms`);
}
if (demandPowerClamped) {
    demandPlausibilityIssues.push("negative_demand");
    demandPlausibilityDetails.push("negative demand clamped");
}
if (demandBelowMinimumExpected) {
    demandPlausibilityIssues.push("below_minimum_house_demand");
    demandPlausibilityDetails.push(
        `below ${Math.round(plausibilityThresholds.minimumHouseDemandW)}W floor`
    );
}
if (chargeSetpointMismatch) {
    demandPlausibilityIssues.push("charge_setpoint_mismatch");
    demandPlausibilityDetails.push("charge setpoint ahead of power");
}
if (dischargeSetpointMismatch) {
    demandPlausibilityIssues.push("discharge_setpoint_mismatch");
    demandPlausibilityDetails.push("discharge setpoint ahead of power");
}

const demandPlausibility = {
    isConsistent: demandPlausibilityIssues.length === 0,
    issues: demandPlausibilityIssues,
    details: demandPlausibilityDetails,
    invalidInputs: demandInvalidInputs,
    retainedInputs: demandRetainedInputs,
    staleInputs: demandStaleInputs,
    thresholds: plausibilityThresholds,
    timing: {
        minInputAgeMs: demandAgeStats.minAgeMs,
        maxInputAgeMs: demandAgeStats.maxAgeMs,
        inputAgeSpreadMs: demandAgeStats.spreadMs,
        exceedsSpreadThreshold: demandTimingSpreadExceeded
    },
    houseDemand: {
        rawPower: demandPowerRaw,
        clampedPower: demandPower,
        zeroFallbackPower: demandPowerZeroFallback,
        isNegative: demandPowerClamped,
        isBelowMinimumExpected: demandBelowMinimumExpected
    },
    setpointMismatch: {
        charge: chargeSetpointMismatch,
        discharge: dischargeSetpointMismatch
    }
};

msg.data = {
    grid: {
        power: gridPowerReading.value
    },
    solar: {
        primaryPower: solarPrimaryPowerReading.value,
        secondaryPower: solarSecondaryPowerReading.value,
        totalPower: solarPrimaryPowerReading.value + solarSecondaryPowerReading.value
    },
    battery: {
        soc: getNumber("sensor.solarflow_800_pro_electric_level", 0, { remember: true }),
        minSoc: getNumber("number.solarflow_800_pro_min_soc", 15, { remember: true }),
        socLimit: getNumber("number.solarflow_800_pro_soc_set", 100, { remember: true }),
        availableWh:
            getNumber("sensor.solarflow_800_pro_available_kwh", 0, { remember: true }) * 1000,
        chargePower: batteryChargePowerReading.value,
        dischargePower: batteryDischargePowerReading.value,
        chargeSetpoint: batteryChargeSetpoint,
        dischargeSetpoint: batteryDischargeSetpoint,
        chargeMaxPower: batteryChargeMaxPower,
        chargeHardwareMaxPower: batteryChargeHardwareMaxPower
    },
    house: {
        demandPower: demandPower,
        demandPowerRaw: demandPowerRaw,
        demandPowerZeroFallback: demandPowerZeroFallback
    },
    forecast: {
        solarRemainingWh:
            solarRemainingWhPrimaryReading.value + solarRemainingWhSecondaryReading.value,
        nextHourWh: nextHourPrimaryReading.value + nextHourSecondaryReading.value
    },
    sun: {
        aboveHorizon: sunAboveHorizon,
        nextRising: sunNextRising
    },
    inverter: {
        acMode: getString("select.solarflow_800_pro_ac_mode"),
        inverseMaxPower: getNumber("sensor.solarflow_800_pro_inverse_max_power", 0, {
            remember: true
        }),
        reachable: getString("binary_sensor.hoymiles600_reachable"),
        producing: getString("binary_sensor.hoymiles600_producing"),
        opendtuStatus: getString("binary_sensor.opendtu_b69d10_status")
    }
};

msg.meta.source = {
    kind: "home_assistant_map"
};
msg.derived.houseDemandPlausibility = demandPlausibility;
msg.meta.normalization = {
    triggerIntervalSeconds: triggerIntervalSeconds,
    retainedReadingMs: retainedReadingMs,
    readings: {
        gridPower: summarizeReading(gridPowerReading),
        solarPrimaryPower: summarizeReading(solarPrimaryPowerReading),
        solarSecondaryPower: summarizeReading(solarSecondaryPowerReading),
        batteryChargePower: summarizeReading(batteryChargePowerReading),
        batteryDischargePower: summarizeReading(batteryDischargePowerReading)
    },
    houseDemand: {
        power: demandPower,
        rawPower: demandPowerRaw,
        zeroFallbackPower: demandPowerZeroFallback,
        isClamped: demandPowerClamped,
        invalidInputs: demandInvalidInputs,
        retainedInputs: demandRetainedInputs,
        staleInputs: demandStaleInputs,
        wouldBeNegativeWithZeroFallback: demandPowerZeroFallback < 0
    },
    plausibility: demandPlausibility
};

context.set("lastValidNumbers", lastValidNumbers);

const telemetry = {
    payload: {
        time: new Date().toISOString(),
        source: "normalize_home_assistant_data",
        triggerIntervalSeconds: triggerIntervalSeconds,
        retainedReadingMs: retainedReadingMs,
        gridState: gridPowerReading.rawState,
        gridParsedPower: gridPowerReading.parsedValue,
        gridPower: gridPowerReading.value,
        gridTimestamp: gridPowerReading.sourceTimestamp,
        gridAgeMs: gridPowerReading.sourceAgeMs,
        gridValid: gridPowerReading.isValid,
        gridStale: gridPowerReading.isStale,
        gridUsedLastValid: gridPowerReading.usedLastValid,
        gridLastValidAgeMs: gridPowerReading.lastValidAgeMs,
        solarPrimaryState: solarPrimaryPowerReading.rawState,
        solarPrimaryParsedPower: solarPrimaryPowerReading.parsedValue,
        solarPrimaryPower: solarPrimaryPowerReading.value,
        solarPrimaryTimestamp: solarPrimaryPowerReading.sourceTimestamp,
        solarPrimaryAgeMs: solarPrimaryPowerReading.sourceAgeMs,
        solarPrimaryValid: solarPrimaryPowerReading.isValid,
        solarPrimaryStale: solarPrimaryPowerReading.isStale,
        solarPrimaryUsedLastValid: solarPrimaryPowerReading.usedLastValid,
        solarPrimaryLastValidAgeMs: solarPrimaryPowerReading.lastValidAgeMs,
        solarSecondaryState: solarSecondaryPowerReading.rawState,
        solarSecondaryParsedPower: solarSecondaryPowerReading.parsedValue,
        solarSecondaryPower: solarSecondaryPowerReading.value,
        solarSecondaryTimestamp: solarSecondaryPowerReading.sourceTimestamp,
        solarSecondaryAgeMs: solarSecondaryPowerReading.sourceAgeMs,
        solarSecondaryValid: solarSecondaryPowerReading.isValid,
        solarSecondaryStale: solarSecondaryPowerReading.isStale,
        solarSecondaryUsedLastValid: solarSecondaryPowerReading.usedLastValid,
        solarSecondaryLastValidAgeMs: solarSecondaryPowerReading.lastValidAgeMs,
        batteryChargeState: batteryChargePowerReading.rawState,
        batteryChargeParsedPower: batteryChargePowerReading.parsedValue,
        batteryChargePower: batteryChargePowerReading.value,
        batteryChargeTimestamp: batteryChargePowerReading.sourceTimestamp,
        batteryChargeAgeMs: batteryChargePowerReading.sourceAgeMs,
        batteryChargeValid: batteryChargePowerReading.isValid,
        batteryChargeStale: batteryChargePowerReading.isStale,
        batteryChargeUsedLastValid: batteryChargePowerReading.usedLastValid,
        batteryChargeLastValidAgeMs: batteryChargePowerReading.lastValidAgeMs,
        batteryDischargeState: batteryDischargePowerReading.rawState,
        batteryDischargeParsedPower: batteryDischargePowerReading.parsedValue,
        batteryDischargePower: batteryDischargePowerReading.value,
        batteryDischargeTimestamp: batteryDischargePowerReading.sourceTimestamp,
        batteryDischargeAgeMs: batteryDischargePowerReading.sourceAgeMs,
        batteryDischargeValid: batteryDischargePowerReading.isValid,
        batteryDischargeStale: batteryDischargePowerReading.isStale,
        batteryDischargeUsedLastValid: batteryDischargePowerReading.usedLastValid,
        batteryDischargeLastValidAgeMs: batteryDischargePowerReading.lastValidAgeMs,
        totalSolarPower: msg.data.solar.totalPower,
        demandPowerRaw: Math.round(demandPowerRaw),
        demandPower: Math.round(demandPower),
        demandPowerZeroFallback: Math.round(demandPowerZeroFallback),
        demandPowerClamped: demandPowerClamped,
        demandWouldBeNegativeWithZeroFallback: demandPowerZeroFallback < 0,
        demandPlausible: demandPlausibility.isConsistent,
        demandPlausibilityIssues: demandPlausibilityIssues.join("|"),
        demandPlausibilityDetails: demandPlausibilityDetails.join("|"),
        demandStaleInputs: demandStaleInputs.join("|"),
        demandInputAgeSpreadMs: demandAgeStats.spreadMs,
        demandMaxInputAgeMs: demandAgeStats.maxAgeMs,
        demandBelowMinimumExpected: demandBelowMinimumExpected,
        demandMinimumExpectedPower: plausibilityThresholds.minimumHouseDemandW,
        demandChargeSetpointMismatch: chargeSetpointMismatch,
        demandDischargeSetpointMismatch: dischargeSetpointMismatch,
        demandInvalidInputs: demandInvalidInputs.join("|"),
        demandRetainedInputs: demandRetainedInputs.join("|")
    }
};

if (demandInvalidInputs.length > 0 || demandPowerClamped || !demandPlausibility.isConsistent) {
    const statusDetails =
        demandInvalidInputs.length > 0
            ? `invalid ${demandInvalidInputs.join(",")}`
            : demandPlausibilityDetails[0] || "negative demand clamped";
    node.status({
        fill: "yellow",
        shape: "ring",
        text: `Demand ${Math.round(demandPower)}W | ${statusDetails}`
    });
} else {
    node.status({
        fill: "green",
        shape: "dot",
        text: `Demand ${Math.round(demandPower)}W`
    });
}

return [msg, telemetry];
