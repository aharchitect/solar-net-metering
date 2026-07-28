const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { runFunctionNode } = require("./helpers/run-function-node");

const scriptPath = path.join(
    __dirname,
    "..",
    "function-nodes",
    "ensure-discharge-actuator-state.js"
);

function execute({
    mode = "output",
    inputLimit = 0,
    outputLimit = 320,
    payload = 360,
    hardwareMax = 1000
} = {}) {
    const execution = runFunctionNode(scriptPath, {
        msg: {
            payload,
            data: {
                inverter: { acMode: mode, inverseMaxPower: hardwareMax },
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

test("only changes the discharge limit when output mode and input limit are already correct", () => {
    const { result } = execute();

    assert.equal(result[0].payload, 360);
    assert.equal(result[1], null);
    assert.equal(result[2], null);
});

test("changes output mode independently", () => {
    const { result } = execute({ mode: "input", outputLimit: 360 });

    assert.equal(result[0], null);
    assert.equal(result[1].payload, 360);
    assert.equal(result[2], null);
});

test("clears an active input limit independently", () => {
    const { result } = execute({ inputLimit: 700, outputLimit: 360 });

    assert.equal(result[0], null);
    assert.equal(result[1], null);
    assert.equal(result[2].payload, 360);
});

test("requests every actuator whose current state differs from the discharge state", () => {
    const { result } = execute({ mode: "input", inputLimit: 700, outputLimit: 320 });

    assert.equal(result[0].payload, 360);
    assert.equal(result[1].payload, 360);
    assert.equal(result[2].payload, 360);
});

test("does not call an actuator when every desired discharge state is already present", () => {
    const { result, statuses } = execute({ outputLimit: 360 });

    assert.equal(result, null);
    assert.deepEqual(statuses, [
        {
            fill: "grey",
            shape: "ring",
            text: "discharge 360W, output mode, input off"
        }
    ]);
});

test("caps an out-of-range payload before the output-limit service receives it", () => {
    const { result } = execute({ payload: 1105, outputLimit: 900, hardwareMax: 1000 });

    assert.equal(result[0].payload, 1000);
    assert.equal(result[1], null);
    assert.equal(result[2], null);
});
