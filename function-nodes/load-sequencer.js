// 1. DATA FROM PREVIOUS NODES
const action = msg.payload;
const exportPower = msg.gridExport || 0; // The extra W we can't store
const now = Date.now();

// 2. STATE PERSISTENCE (Track status of loads)
let loads = context.get("loads") || {
    dryer: { active: false, lastChange: 0, power: 250, entity: "switch.dryer" },
    dehumidifier: { active: false, lastChange: 0, power: 150, entity: "switch.dehumidifier" }
};

// 3. MINIMUM RUN TIME (Safety: 15 minutes)
const minRunTime = 15 * 60 * 1000;

// 4. LOGIC: ADDING LOADS (Turn ON)
if (action.includes("OVERFLOW")) {
    // Try to turn on the first available load in order of priority
    if (!loads.dehumidifier.active && exportPower > loads.dehumidifier.power + 50) {
        loads.dehumidifier.active = true;
        loads.dehumidifier.lastChange = now;
        node.send({ payload: "ON", topic: loads.dehumidifier.entity });
    } else if (!loads.dryer.active && exportPower > loads.dryer.power + 100) {
        loads.dryer.active = true;
        loads.dryer.lastChange = now;
        node.send({ payload: "ON", topic: loads.dryer.entity });
    }
}

// 5. LOGIC: REMOVING LOADS (Turn OFF)
// If we are back to NORMAL (importing or zero), check if we need to shed load
if (action === "NORMAL" || exportPower < 20) {
    // Turn off in reverse order, but only if they've run long enough
    if (loads.dryer.active && now - loads.dryer.lastChange > minRunTime) {
        loads.dryer.active = false;
        node.send({ payload: "OFF", topic: loads.dryer.entity });
    } else if (loads.dehumidifier.active && now - loads.dehumidifier.lastChange > minRunTime) {
        loads.dehumidifier.active = false;
        node.send({ payload: "OFF", topic: loads.dehumidifier.entity });
    }
}

context.set("loads", loads);
node.status({
    fill: loads.dryer.active ? "green" : "grey",
    shape: "dot",
    text: `Dryer: ${loads.dryer.active} | Dehum: ${loads.dehumidifier.active}`
});
