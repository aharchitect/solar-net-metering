# Message Schema

This document describes the internal JSON message contract used by the main controller flow.

The goal of this schema is:

- encapsulate Home Assistant entity ids in one normalization step
- provide semantic, reusable data buckets for later function nodes
- keep intermediate calculations separate from final control actions
- make the flow easier to understand, test, and reuse

Normalized controller nodes are expected to fail fast when mandatory contract fields are missing.
They should not silently replace missing structured input with fallback `0` values.

## Buckets

The main controller path uses these top-level message buckets:

| Bucket        | Purpose                                                   | Main producer nodes                                            |
| ------------- | --------------------------------------------------------- | -------------------------------------------------------------- |
| `msg.payload` | Raw input from upstream, or node-specific output payloads | Home Assistant collector, Trigger Timer, hardware/output nodes |
| `msg.data`    | Normalized measured domain data                           | `normalize-home-assistant-data.js`                             |
| `msg.derived` | Intermediate calculated values                            | statistical, budget, controller nodes                          |
| `msg.action`  | Concrete control intentions and commands                  | decision, charge, discharge controller nodes                   |
| `msg.meta`    | Technical metadata and classification                     | trigger, normalization, statistics nodes                       |

## Contract Scope

This schema applies to the main controller chain around:

- `normalize-home-assistant-data.js`
- `statistical-averaging-of-house-load-and-solar.js`
- `battery-budget.js`
- `decision-day-night-charge-or-discharge.js`
- `ControllerDayHandling.js`
- `gentle-controller-discharge-filter.js`
- `adjust-battery-charging.js`
- `adjust-battery-discharging.js`

Two older side branches still use their own custom `msg.payload` structure and are not yet part of the normalized contract:

- `steuerlogik-drosselung-hm-600.js`
- `load-sequencer.js`

## Dictionary

### `msg.payload`

`msg.payload` is intentionally not normalized. Its meaning depends on where in the flow the message is.

| Path          | Type          | Meaning                                               | Producer                                                      |
| ------------- | ------------- | ----------------------------------------------------- | ------------------------------------------------------------- |
| `msg.payload` | object        | Raw Home Assistant entity map                         | upstream HA collector                                         |
| `msg.payload` | number/string | Trigger interval in seconds                           | trigger input before `trigger-timer.js`                       |
| `msg.payload` | boolean       | Trigger pulse (`true`)                                | `trigger-timer.js`                                            |
| `msg.payload` | number        | Hardware charge/discharge command                     | `adjust-battery-charging.js`, `adjust-battery-discharging.js` |
| `msg.payload` | object        | Flat telemetry/log row on controller debug/log output | second output of `ControllerDayHandling.js`                   |

### `msg.data`

Normalized measured values. These fields should be treated as facts from the outside world.

#### `msg.data.grid`

| Path                  | Type   | Unit | Meaning                                                              | Producer                           |
| --------------------- | ------ | ---- | -------------------------------------------------------------------- | ---------------------------------- |
| `msg.data.grid.power` | number | W    | Grid power at the smart meter. Negative means export to public grid. | `normalize-home-assistant-data.js` |

#### `msg.data.solar`

| Path                            | Type   | Unit | Meaning                           | Producer                           |
| ------------------------------- | ------ | ---- | --------------------------------- | ---------------------------------- |
| `msg.data.solar.primaryPower`   | number | W    | Power from primary solar source   | `normalize-home-assistant-data.js` |
| `msg.data.solar.secondaryPower` | number | W    | Power from secondary solar source | `normalize-home-assistant-data.js` |
| `msg.data.solar.totalPower`     | number | W    | Sum of all mapped solar sources   | `normalize-home-assistant-data.js` |

#### `msg.data.battery`

| Path                                      | Type   | Unit | Meaning                                           | Producer                           |
| ----------------------------------------- | ------ | ---- | ------------------------------------------------- | ---------------------------------- |
| `msg.data.battery.soc`                    | number | %    | Current battery state of charge                   | `normalize-home-assistant-data.js` |
| `msg.data.battery.minSoc`                 | number | %    | Minimum allowed state of charge                   | `normalize-home-assistant-data.js` |
| `msg.data.battery.socLimit`               | number | %    | Configured upper SoC limit                        | `normalize-home-assistant-data.js` |
| `msg.data.battery.availableWh`            | number | Wh   | Available battery energy                          | `normalize-home-assistant-data.js` |
| `msg.data.battery.chargePower`            | number | W    | Actual battery charging power                     | `normalize-home-assistant-data.js` |
| `msg.data.battery.dischargePower`         | number | W    | Actual battery discharge power to house           | `normalize-home-assistant-data.js` |
| `msg.data.battery.chargeSetpoint`         | number | W    | Current charge limit/setpoint sent to hardware    | `normalize-home-assistant-data.js` |
| `msg.data.battery.dischargeSetpoint`      | number | W    | Current discharge limit/setpoint sent to hardware | `normalize-home-assistant-data.js` |
| `msg.data.battery.chargeMaxPower`         | number | W    | Reported battery charge maximum                   | `normalize-home-assistant-data.js` |
| `msg.data.battery.chargeHardwareMaxPower` | number | W    | Hardware max charge limit from entity attribute   | `normalize-home-assistant-data.js` |

#### `msg.data.house`

| Path                         | Type   | Unit | Meaning                       | Producer                           |
| ---------------------------- | ------ | ---- | ----------------------------- | ---------------------------------- |
| `msg.data.house.demandPower` | number | W    | Calculated whole-house demand | `normalize-home-assistant-data.js` |

#### `msg.data.forecast`

| Path                                 | Type   | Unit | Meaning                                     | Producer                           |
| ------------------------------------ | ------ | ---- | ------------------------------------------- | ---------------------------------- |
| `msg.data.forecast.solarRemainingWh` | number | Wh   | Forecast remaining solar energy for the day | `normalize-home-assistant-data.js` |
| `msg.data.forecast.nextHourWh`       | number | Wh   | Forecast solar energy for the next hour     | `normalize-home-assistant-data.js` |

#### `msg.data.sun`

| Path                        | Type         | Unit         | Meaning                          | Producer                           |
| --------------------------- | ------------ | ------------ | -------------------------------- | ---------------------------------- |
| `msg.data.sun.aboveHorizon` | boolean      | -            | Whether sun is above horizon     | `normalize-home-assistant-data.js` |
| `msg.data.sun.nextRising`   | string\|null | ISO datetime | Next sunrise from Home Assistant | `normalize-home-assistant-data.js` |

#### `msg.data.inverter`

| Path                                | Type   | Unit | Meaning                         | Producer                           |
| ----------------------------------- | ------ | ---- | ------------------------------- | ---------------------------------- |
| `msg.data.inverter.acMode`          | string | -    | Inverter AC mode                | `normalize-home-assistant-data.js` |
| `msg.data.inverter.inverseMaxPower` | number | W    | Reported inverter maximum power | `normalize-home-assistant-data.js` |
| `msg.data.inverter.reachable`       | string | -    | Reachability state              | `normalize-home-assistant-data.js` |
| `msg.data.inverter.producing`       | string | -    | Producing state                 | `normalize-home-assistant-data.js` |
| `msg.data.inverter.opendtuStatus`   | string | -    | OpenDTU status                  | `normalize-home-assistant-data.js` |

### `msg.derived`

Intermediate calculated values. These fields are reusable helper values, not direct measurements and not direct commands.

#### `msg.derived.demand`

| Path                                 | Type   | Unit  | Meaning                                                          | Producer                                           |
| ------------------------------------ | ------ | ----- | ---------------------------------------------------------------- | -------------------------------------------------- |
| `msg.derived.demand.current`         | number | W     | Current house demand used in 5-minute statistics                 | `statistical-averaging-of-house-load-and-solar.js` |
| `msg.derived.demand.average`         | number | W     | Average demand over the 5-minute history                         | `statistical-averaging-of-house-load-and-solar.js` |
| `msg.derived.demand.median`          | number | W     | Median demand over the 5-minute history                          | `statistical-averaging-of-house-load-and-solar.js` |
| `msg.derived.demand.defensiveTarget` | number | W     | Conservative demand target used by controllers                   | `statistical-averaging-of-house-load-and-solar.js` |
| `msg.derived.demand.stdDev`          | number | W     | Standard deviation of demand in the 5-minute window              | `statistical-averaging-of-house-load-and-solar.js` |
| `msg.derived.demand.trend`           | number | W     | Rising or falling demand trend across the 5-minute window        | `statistical-averaging-of-house-load-and-solar.js` |
| `msg.derived.demand.trendDirection`  | string | -     | Demand trend direction: `up`, `down`, or `flat`                  | `statistical-averaging-of-house-load-and-solar.js` |
| `msg.derived.demand.trendChanges`    | number | count | Number of demand trend direction flips in the short trend window | `statistical-averaging-of-house-load-and-solar.js` |

#### `msg.derived.solar`

| Path                               | Type   | Unit  | Meaning                                                               | Producer                                           |
| ---------------------------------- | ------ | ----- | --------------------------------------------------------------------- | -------------------------------------------------- |
| `msg.derived.solar.livePower`      | number | W     | Current solar power used for reactive control                         | `statistical-averaging-of-house-load-and-solar.js` |
| `msg.derived.solar.averagePower`   | number | W     | Average solar power over the 5-minute history                         | `statistical-averaging-of-house-load-and-solar.js` |
| `msg.derived.solar.stdDev`         | number | W     | Standard deviation of solar power in the 5-minute window              | `statistical-averaging-of-house-load-and-solar.js` |
| `msg.derived.solar.trend`          | number | W     | Rising or falling solar trend across the 5-minute window              | `statistical-averaging-of-house-load-and-solar.js` |
| `msg.derived.solar.trendDirection` | string | -     | Solar trend direction: `up`, `down`, or `flat`                        | `statistical-averaging-of-house-load-and-solar.js` |
| `msg.derived.solar.trendChanges`   | number | count | Number of solar trend direction flips in the short trend window       | `statistical-averaging-of-house-load-and-solar.js` |
| `msg.derived.solar.effectivePower` | number | W     | Hybrid solar value combining stable and live solar for charge control | `ControllerDayHandling.js`                         |

#### `msg.derived.forecast`

| Path                                      | Type   | Unit | Meaning                                         | Producer            |
| ----------------------------------------- | ------ | ---- | ----------------------------------------------- | ------------------- |
| `msg.derived.forecast.nextHourWh`         | number | Wh   | Next-hour forecast copied for derived logic     | `battery-budget.js` |
| `msg.derived.forecast.hoursToUsableSolar` | number | h    | Estimated hours until usable solar is available | `battery-budget.js` |
| `msg.derived.forecast.hoursToSunrise`     | string | h    | Hours until sunrise as formatted decimal string | `battery-budget.js` |

#### `msg.derived.energy`

| Path                                    | Type   | Unit | Meaning                                                   | Producer                   |
| --------------------------------------- | ------ | ---- | --------------------------------------------------------- | -------------------------- |
| `msg.derived.energy.theoreticalSurplus` | number | W    | Effective solar minus defensive demand                    | `ControllerDayHandling.js` |
| `msg.derived.energy.predictiveSurplus`  | number | W    | Predictive surplus after trend and solar-ramp corrections | `ControllerDayHandling.js` |

### `msg.action`

Concrete control intentions and commands.

#### `msg.action.decision`

| Path                                    | Type    | Meaning                                                 | Producer                                    |
| --------------------------------------- | ------- | ------------------------------------------------------- | ------------------------------------------- |
| `msg.action.decision.isSolarDayOver`    | boolean | Day/night routing decision for charge vs discharge path | `decision-day-night-charge-or-discharge.js` |
| `msg.action.decision.batteryHasReserve` | boolean | Whether battery SoC is above minimum reserve            | `decision-day-night-charge-or-discharge.js` |

#### `msg.action.charge`

| Path                             | Type   | Unit | Meaning                                                 | Producer                   |
| -------------------------------- | ------ | ---- | ------------------------------------------------------- | -------------------------- |
| `msg.action.charge.targetPower`  | number | W    | Raw target charge power before final smoothing/rounding | `ControllerDayHandling.js` |
| `msg.action.charge.commandPower` | number | W    | Final charge command to be used by hardware node        | `ControllerDayHandling.js` |
| `msg.action.charge.ruleApplied`  | string | -    | Main control rule that determined the command           | `ControllerDayHandling.js` |
| `msg.action.charge.clampReason`  | string | -    | Clamp reason if limited by battery/inverter/floor       | `ControllerDayHandling.js` |

#### `msg.action.battery.discharge`

| Path                                          | Type    | Unit | Meaning                                                      | Producer                                |
| --------------------------------------------- | ------- | ---- | ------------------------------------------------------------ | --------------------------------------- |
| `msg.action.battery.discharge.forcedRate`     | number  | W    | Maximum desired discharge rate based on budget until sunrise | `battery-budget.js`                     |
| `msg.action.battery.discharge.commandPower`   | number  | W    | Final discharge command after smoothing and safety rules     | `gentle-controller-discharge-filter.js` |
| `msg.action.battery.discharge.requiredChange` | number  | W    | Raw discharge gap before smoothing                           | `gentle-controller-discharge-filter.js` |
| `msg.action.battery.discharge.isStable`       | boolean | -    | Whether the current discharge situation is inside deadband   | `gentle-controller-discharge-filter.js` |
| `msg.action.battery.discharge.gridPower`      | number  | W    | Grid power snapshot used by discharge controller             | `gentle-controller-discharge-filter.js` |

### `msg.meta`

Technical metadata and classification.

#### `msg.meta.source`

| Path                   | Type   | Meaning                                                 | Producer                           |
| ---------------------- | ------ | ------------------------------------------------------- | ---------------------------------- |
| `msg.meta.source.kind` | string | Input source descriptor, currently `home_assistant_map` | `normalize-home-assistant-data.js` |

#### `msg.meta.trigger`

| Path                               | Type   | Unit | Meaning                                     | Producer           |
| ---------------------------------- | ------ | ---- | ------------------------------------------- | ------------------ |
| `msg.meta.trigger.intervalSeconds` | number | s    | Configured trigger interval                 | `trigger-timer.js` |
| `msg.meta.trigger.intervalMs`      | number | ms   | Configured trigger interval in milliseconds | `trigger-timer.js` |

#### `msg.meta.history`

| Path                                      | Type   | Unit  | Meaning                                                        | Producer                                           |
| ----------------------------------------- | ------ | ----- | -------------------------------------------------------------- | -------------------------------------------------- |
| `msg.meta.history.windowSeconds`          | number | s     | Statistical history window length                              | `statistical-averaging-of-house-load-and-solar.js` |
| `msg.meta.history.triggerIntervalSeconds` | number | s     | Trigger interval used to derive sample count                   | `statistical-averaging-of-house-load-and-solar.js` |
| `msg.meta.history.triggerIntervalMs`      | number | ms    | Trigger interval in milliseconds                               | `statistical-averaging-of-house-load-and-solar.js` |
| `msg.meta.history.samples`                | number | count | Number of samples retained for the 5-minute window             | `statistical-averaging-of-house-load-and-solar.js` |
| `msg.meta.history.trendWindowSeconds`     | number | s     | Short trend-history window used for direction-change checks    | `statistical-averaging-of-house-load-and-solar.js` |
| `msg.meta.history.trendSamples`           | number | count | Number of trend evaluations retained in the short trend window | `statistical-averaging-of-house-load-and-solar.js` |

#### `msg.meta.stability`

| Path                                                 | Type   | Meaning                                                                                             | Producer                                           |
| ---------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `msg.meta.stability.mode`                            | string | Stability classification: `stable_stable`, `solar_unstable`, `demand_unstable`, `unstable_unstable` | `statistical-averaging-of-house-load-and-solar.js` |
| `msg.meta.stability.demand`                          | string | Demand stability state: `stable` or `unstable`                                                      | `statistical-averaging-of-house-load-and-solar.js` |
| `msg.meta.stability.solar`                           | string | Solar stability state: `stable` or `unstable`                                                       | `statistical-averaging-of-house-load-and-solar.js` |
| `msg.meta.stability.thresholds.demandStdDev`         | number | Demand standard deviation threshold                                                                 | `statistical-averaging-of-house-load-and-solar.js` |
| `msg.meta.stability.thresholds.solarStdDev`          | number | Solar standard deviation threshold                                                                  | `statistical-averaging-of-house-load-and-solar.js` |
| `msg.meta.stability.thresholds.demandTrendDeadband`  | number | Demand trend deadband used to classify `up` or `down`                                               | `statistical-averaging-of-house-load-and-solar.js` |
| `msg.meta.stability.thresholds.solarTrendDeadband`   | number | Solar trend deadband used to classify `up` or `down`                                                | `statistical-averaging-of-house-load-and-solar.js` |
| `msg.meta.stability.thresholds.unstableTrendChanges` | number | Number of short-window trend flips required to mark the signal unstable                             | `statistical-averaging-of-house-load-and-solar.js` |
| `msg.meta.stability.stats.demandAverage`             | number | 5-minute average demand snapshot                                                                    | `statistical-averaging-of-house-load-and-solar.js` |
| `msg.meta.stability.stats.demandStdDev`              | number | 5-minute demand standard deviation snapshot                                                         | `statistical-averaging-of-house-load-and-solar.js` |
| `msg.meta.stability.stats.demandTrend`               | number | 5-minute demand trend snapshot                                                                      | `statistical-averaging-of-house-load-and-solar.js` |
| `msg.meta.stability.stats.demandTrendDirection`      | string | Current demand trend direction                                                                      | `statistical-averaging-of-house-load-and-solar.js` |
| `msg.meta.stability.stats.demandTrendChanges`        | number | Count of demand trend direction flips in the short trend window                                     | `statistical-averaging-of-house-load-and-solar.js` |
| `msg.meta.stability.stats.solarAverage`              | number | 5-minute average solar snapshot                                                                     | `statistical-averaging-of-house-load-and-solar.js` |
| `msg.meta.stability.stats.solarStdDev`               | number | 5-minute solar standard deviation snapshot                                                          | `statistical-averaging-of-house-load-and-solar.js` |
| `msg.meta.stability.stats.solarTrend`                | number | 5-minute solar trend snapshot                                                                       | `statistical-averaging-of-house-load-and-solar.js` |
| `msg.meta.stability.stats.solarTrendDirection`       | string | Current solar trend direction                                                                       | `statistical-averaging-of-house-load-and-solar.js` |
| `msg.meta.stability.stats.solarTrendChanges`         | number | Count of solar trend direction flips in the short trend window                                      | `statistical-averaging-of-house-load-and-solar.js` |

## Node Read/Write Overview

| Node                                               | Reads                                                                | Writes                                                                                           |
| -------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `trigger-timer.js`                                 | `msg.payload`                                                        | `msg.payload`, `msg.meta.trigger`                                                                |
| `normalize-home-assistant-data.js`                 | `msg.payload`                                                        | `msg.data`, `msg.meta.source`                                                                    |
| `statistical-averaging-of-house-load-and-solar.js` | `msg.data`, `msg.meta.trigger`                                       | `msg.derived.demand`, `msg.derived.solar`, `msg.meta.history`, `msg.meta.stability`              |
| `battery-budget.js`                                | `msg.data`                                                           | `msg.derived.forecast`, `msg.action.battery.discharge.forcedRate`                                |
| `decision-day-night-charge-or-discharge.js`        | `msg.data`, `msg.derived.solar.livePower`                            | `msg.action.decision`                                                                            |
| `ControllerDayHandling.js`                         | `msg.data`, `msg.derived`, `msg.meta.stability`                      | `msg.derived.solar.effectivePower`, `msg.derived.energy.theoreticalSurplus`, `msg.action.charge` |
| `gentle-controller-discharge-filter.js`            | `msg.data`, `msg.derived`, `msg.action.battery.discharge.forcedRate` | `msg.action.battery.discharge.commandPower` and related discharge fields                         |
| `adjust-battery-charging.js`                       | `msg.data`, `msg.action.charge`                                      | hardware output `msg.payload`                                                                    |
| `adjust-battery-discharging.js`                    | `msg.data`, `msg.action.battery.discharge`                           | hardware output `msg.payload`                                                                    |

## Controller Telemetry Output

`ControllerDayHandling.js` has a second output for telemetry/logging. That second message is separate from the internal contract above.

Its `msg.payload` is a flat log record intended for CSV export and replay datasets. It currently includes values such as:

- controller mode
- applied rule and clamp reason
- grid power
- current and median demand
- live, stable, and effective solar power
- theoretical surplus
- target and final charge command
- SoC and minimum SoC
- history sample count and standard deviations

## Guidance

- New controller logic should prefer `msg.data`, `msg.derived`, `msg.action`, and `msg.meta`.
- Raw Home Assistant entity ids should stay inside `normalize-home-assistant-data.js`.
- New derived helper values should go into `msg.derived`.
- New hardware intentions or switching commands should go into `msg.action`.
- Technical scheduling, history, tracing, or classification values should go into `msg.meta`.
