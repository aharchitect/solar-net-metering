
// Definier Funktion zur Erstellung der Log-Nachricht
function createLogFileMsg(dtuState, invStateProducing, invStateReachable, statusZeroInjection, pwrConsumption, pwrSecondSource, socLevelBattery, setPercentMsg, turnOnMsg, turnOffMsg, debugMsg) {
    const now = new Date();
    const formattedTime = now.toLocaleString('de-DE', { hour12: false }); // Formatiert Zeit als 'Tag.Monat.Jahr Stunden:Minuten:Sekunden'

    // Konvertiert Zahlenwerte zu Strings mit Komma als Dezimaltrennzeichen
    const formattedPwrConsumption = pwrConsumption.toLocaleString('de-DE');
    const formattedPwrSecondSource = pwrSecondSource.toLocaleString('de-DE');
    
    return {
        payload: {
            "time": formattedTime,
            "dtuState": dtuState,
            "invStateProducing": invStateProducing,
            "invStateReachable": invStateReachable,
            "statusZeroInjection": statusZeroInjection,
            "pwrConsumption": formattedPwrConsumption,
            "pwrSecondSource": formattedPwrSecondSource,
            "socLevelBattery": socLevelBattery,
            "setPercentMsg": setPercentMsg ? setPercentMsg.payload : null,
            "turnOnMsg": turnOnMsg ? turnOnMsg.payload : null,
            "turnOffMsg": turnOffMsg ? turnOffMsg.payload : null,
            "debugMsg": debugMsg.payload
        }
    };
}

// Definiert min und max Prozentwerte für die DTU-Ausgangsleistung
const maxOutputPowerInv = parseFloat(msg.payload.maxOutputPowerInv); // Maximale Ausgangsleistung des Wechselrichters in Watt
const pwrSteps = maxOutputPowerInv / 100; // Berechnet die Leistung pro Prozent
const minOutputZeroInjection = parseFloat(msg.payload.minOutputZeroInjection); // Minimale Leistung in Prozent bei aktivierter Nulleinspeisung
const maxOutputZeroInjection = parseFloat(msg.payload.maxOutputZeroInjection); // Maximale Leistung in Prozent bei aktivierter Nulleinspeisung
const maxOutputAtFullSoc = parseFloat(msg.payload.maxOutputAtFullSoc); // Maximale Ausgangsleistung in Prozent bei vollem Batterie-SoC
const staticInverterOutputPower = parseFloat(msg.payload.staticInverterOutputPower); // Voreingestellte Ausgangsleistung, wenn Nulleinspeisung deaktiviert ist
const minPowerInverter = minOutputZeroInjection * pwrSteps; // Berechnet die minimale Leistung in Watt, basierend auf dem Prozentwert und den Leistungsschritten

// Definiert Schwellenwerte für den Batterie-SoC
const offThresholdInv = parseFloat(msg.payload.offThresholdInv); // Batterie-SoC-Schwelle zum Ausschalten des Wechselrichters
const onThresholdInv = parseFloat(msg.payload.onThresholdInv); // Batterie-SoC-Schwelle zum Einschalten des Wechselrichters

// Extrahiert Daten aus msg.payload für Steuerungsentscheidungen
const dtuState = msg.payload.dtuState; // Der aktuelle Betriebszustand der DTU (Datenübertragungseinheit)
const pwrSecondSource = parseFloat(msg.payload.pwrSecondSource); // Leistung der zweiten Energiequelle in Watt
const pwrConsumption = parseFloat(msg.payload.pwrConsumption); // Aktueller Gesamtstromverbrauch in Watt
const invStateProducing = msg.payload.invStateProducing; // Gibt an, ob der Wechselrichter aktuell Strom produziert
const invStateReachable = msg.payload.invStateReachable; // Verfügbarkeitsstatus des Wechselrichters
const socLevelBattery = parseFloat(msg.payload.socLevelBattery); // Der aktuelle Ladezustand der Batterie in Prozent
const statusZeroInjection = msg.payload.statusZeroInjection; // Aktueller Status der Nulleinspeisung ('on' oder 'off')

// Entscheidungslogik für die Ausgabe der Befehle basierend auf dem Zustand und den Messdaten
let setPercentMsg = null;
let turnOnMsg = null;
let turnOffMsg = null;
let debugMsg = null;

// Steuerung basierend auf dem Status der Nulleinspeisung
if (statusZeroInjection !== "on") {
    if (invStateProducing === "on") {
        setPercentMsg = { payload: staticInverterOutputPower };
        debugMsg = { payload: "Nulleinspeisung deaktiviert, statische Leistung angewendet" };
    } else {
        debugMsg = { payload: "Nulleinspeisung deaktiviert, Wechselrichter aus" };
    }
    const logFileMsg = createLogFileMsg(dtuState, invStateProducing, invStateReachable, statusZeroInjection, pwrConsumption, pwrSecondSource, socLevelBattery, setPercentMsg, turnOnMsg, turnOffMsg, debugMsg);
    return [setPercentMsg, turnOnMsg, turnOffMsg, debugMsg, logFileMsg];
} else {
    debugMsg = { payload: "Nulleinspeisung aktiviert" };
}

// Überprüft die Erreichbarkeit und Betriebsbereitschaft der Systemkomponenten
if (dtuState !== "on" || invStateReachable !== "on") {
    debugMsg = { payload: `DTU offline oder Wechselrichter nicht erreichbar` };
    const logFileMsg = createLogFileMsg(dtuState, invStateProducing, invStateReachable, statusZeroInjection, pwrConsumption, pwrSecondSource, socLevelBattery, setPercentMsg, turnOnMsg, turnOffMsg, debugMsg);
    return [null, null, null, debugMsg, logFileMsg];
} else {
    debugMsg = { payload: `DTU und Wechselrichter sind online` };
}

// Berechnet die erforderliche Leistungskorrektur basierend auf dem aktuellen Verbrauch und der Zweitquelle
let powerDifference = pwrConsumption - pwrSecondSource;

// Steuerung des Wechselrichters basierend auf dem Batterie-SoC und der Differenzleistung
if (socLevelBattery <= offThresholdInv && invStateProducing === "on") {
    turnOffMsg = { payload: "OFF" };
    const logFileMsg = createLogFileMsg(dtuState, invStateProducing, invStateReachable, statusZeroInjection, pwrConsumption, pwrSecondSource, socLevelBattery, setPercentMsg, turnOnMsg, turnOffMsg, debugMsg);
    return [setPercentMsg, turnOnMsg, turnOffMsg, debugMsg, logFileMsg];
} else {
    // Zuerst wird überprüft, ob der Wechselrichter Strom produziert
    if (invStateProducing === "on") {
        if (powerDifference < minPowerInverter) {
            // Sendet ein Signal, um den Wechselrichter auszuschalten, falls die Differenzleistung unter dem Mindestniveau liegt
            turnOffMsg = { payload: "OFF" };
        } else {
            // Berechnet den erforderlichen Leistungsprozentsatz, wenn keine Ausschaltanforderung vorliegt
            let requiredPercent = Math.floor(powerDifference / pwrSteps);
            let effectiveMaxOutput = socLevelBattery === 100 ? maxOutputAtFullSoc : maxOutputZeroInjection;
            requiredPercent = Math.max(minOutputZeroInjection, Math.min(requiredPercent, effectiveMaxOutput));
            setPercentMsg = { payload: requiredPercent };
        }
    } else if (socLevelBattery >= onThresholdInv && powerDifference >= minPowerInverter) {
        // Überprüft, ob der Batterie-SoC oberhalb des Schwellenwertes liegt und die Differenzleistung ausreichend ist
        let requiredPercent = Math.floor(powerDifference / pwrSteps);
        let effectiveMaxOutput = socLevelBattery === 100 ? maxOutputAtFullSoc : maxOutputZeroInjection;
        requiredPercent = Math.max(minOutputZeroInjection, Math.min(requiredPercent, effectiveMaxOutput));
        setPercentMsg = { payload: requiredPercent };
        turnOnMsg = { payload: "ON" };
    } else {
        // Keine Aktion erforderlich, da der Wechselrichter aus ist und die Bedingungen zum Einschalten nicht erfüllt sind
        debugMsg = { payload: "Wechselrichter bleibt aus - Bedingungen zum Einschalten nicht erfüllt" };
    }
}

const logFileMsg = createLogFileMsg(dtuState, invStateProducing, invStateReachable, statusZeroInjection, pwrConsumption, pwrSecondSource, socLevelBattery, setPercentMsg, turnOnMsg, turnOffMsg, debugMsg);
// Rückgabe der Steuerbefehle
return [setPercentMsg, turnOnMsg, turnOffMsg, debugMsg, logFileMsg];
