const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { runFunctionNode } = require("./helpers/run-function-node");

const scriptPath = path.join(__dirname, "..", "function-nodes", "ensure-charge-actuator-state.js");

function execute({ mode = "input", inputLimit = 700, outputLimit = 0, payload = 740 } = {}) {
    const execution = runFunctionNode(scriptPath, {
        msg: {
            payload,
            data: {
                inverter: {
                    acMode: mode
                },
                battery: {
                    chargeSetpoint: inputLimit,
                    dischargeSetpoint: outputLimit
                }
            }
        }
    });

    return {
        ...execution,
        result: execution.result === null ? null : JSON.parse(JSON.stringify(execution.result))
    };
}

test("only changes the charge limit when input mode and output limit are already correct", () => {
    const { result, statuses } = execute();

    assert.deepEqual(result, [
        {
            payload: 740,
            data: {
                inverter: { acMode: "input" },
                battery: { chargeSetpoint: 700, dischargeSetpoint: 0 }
            }
        },
        null,
        null
    ]);
    assert.deepEqual(statuses, [
        {
            fill: "blue",
            shape: "dot",
            text: "charge 740W"
        }
    ]);
});

test("changes mode independently when the inverter is in output mode", () => {
    const { result, statuses } = execute({
        mode: "output",
        inputLimit: 740,
        outputLimit: 0
    });

    assert.equal(result[0], null);
    assert.equal(result[1].payload, 740);
    assert.equal(result[2], null);
    assert.deepEqual(statuses, [
        {
            fill: "blue",
            shape: "dot",
            text: "mode output->input"
        }
    ]);
});

test("clears an active discharge limit independently", () => {
    const { result, statuses } = execute({ inputLimit: 740, outputLimit: 320 });

    assert.equal(result[0], null);
    assert.equal(result[1], null);
    assert.equal(result[2].payload, 740);
    assert.deepEqual(statuses, [
        {
            fill: "blue",
            shape: "dot",
            text: "output 320W->0"
        }
    ]);
});

test("requests every actuator whose current state differs from the charge state", () => {
    const { result } = execute({ mode: "output", inputLimit: 700, outputLimit: 320 });

    assert.equal(result[0].payload, 740);
    assert.equal(result[1].payload, 740);
    assert.equal(result[2].payload, 740);
});

test("does not call any actuator when the desired input limit is already requested", () => {
    const { result, statuses } = execute({ inputLimit: 740 });

    assert.equal(result, null);
    assert.deepEqual(statuses, [
        {
            fill: "grey",
            shape: "ring",
            text: "charge 740W, input mode, output off"
        }
    ]);
});
