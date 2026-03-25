let triggerTime = parseFloat(msg.payload); // Zeit in Sekunden aus dem input
let timerId = flow.get("timerId") || null; // Holen des Timer-IDs aus dem Flow-Kontext
let endTime = flow.get("endTime") || Date.now() + triggerTime * 1000; // Endzeit aus Flow-Kontext oder neu berechnen
const triggerIntervalSeconds = Math.max(1, triggerTime || 1);

function buildTriggerMeta() {
    return {
        trigger: {
            intervalSeconds: triggerIntervalSeconds,
            intervalMs: triggerIntervalSeconds * 1000
        }
    };
}

// Bestehenden Timer löschen, falls vorhanden
if (timerId) {
    clearInterval(timerId);
}

// Funktion zur Aktualisierung des Node-Status
function updateCountdown() {
    let remainingTime = Math.ceil((endTime - Date.now()) / 1000);
    if (remainingTime > 0) {
        node.status({ fill: "red", shape: "ring", text: `Trigger in ${remainingTime}s` });
    } else {
        node.status({ fill: "green", shape: "dot", text: "Triggered" });
        endTime = Date.now() + triggerIntervalSeconds * 1000; // Neu berechnen des Endzeitpunkts für kontinuierliche Wiederholungen
        node.send({
            payload: true,
            meta: buildTriggerMeta()
        }); // Sende 'true' bei Ablauf des Timers
    }
}

// Setzen des Intervall-Timers
timerId = setInterval(() => {
    updateCountdown();
}, 1000); // Jede Sekunde aktualisieren

// Speichern des Timer-IDs und des Endzeitpunkts im Flow-Kontext
flow.set("timerId", timerId);
flow.set("endTime", endTime);
flow.set("triggerIntervalSeconds", triggerIntervalSeconds);

// Initialer Aufruf zur Statusaktualisierung
updateCountdown();

return null; // Keine direkte Nachrichtenausgabe
