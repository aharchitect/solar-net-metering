const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { runFunctionNode } = require("./helpers/run-function-node");

const loadSequencerScriptPath = path.join(__dirname, "..", "function-nodes", "load-sequencer.js");

function executeLoadSequencer({ payload, gridExport = 0, contextState, now } = {}) {
    return runFunctionNode(loadSequencerScriptPath, {
        now: now || "2026-07-06T13:00:00.000Z",
        contextState,
        msg: {
            payload,
            gridExport
        }
    });
}

function toPlain(value) {
    return JSON.parse(JSON.stringify(value));
}

test("turns on the dehumidifier first when battery-full overflow has enough export", () => {
    const { sentMessages, contextState, statuses } = executeLoadSequencer({
        payload: "BATTERY_FULL_OVERFLOW",
        gridExport: 1050
    });

    assert.deepEqual(toPlain(sentMessages), [
        {
            payload: "ON",
            topic: "switch.dehumidifier"
        }
    ]);
    assert.equal(contextState.loads.dehumidifier.active, true);
    assert.equal(contextState.loads.dryer.active, false);
    assert.deepEqual(statuses, [
        {
            fill: "grey",
            shape: "dot",
            text: "Dryer: false | Dehum: true"
        }
    ]);
});

test("does not start the dehumidifier when overflow export is too small", () => {
    const { sentMessages, contextState, statuses } = executeLoadSequencer({
        payload: "BATTERY_FULL_OVERFLOW",
        gridExport: 180
    });

    assert.deepEqual(toPlain(sentMessages), []);
    assert.equal(contextState.loads.dehumidifier.active, false);
    assert.equal(contextState.loads.dryer.active, false);
    assert.deepEqual(statuses, [
        {
            fill: "grey",
            shape: "dot",
            text: "Dryer: false | Dehum: false"
        }
    ]);
});
