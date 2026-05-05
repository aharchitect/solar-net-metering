const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function clone(value) {
    if (value === undefined) {
        return undefined;
    }

    return structuredClone(value);
}

function createStore(initialState = {}) {
    const state = clone(initialState) || {};

    return {
        api: {
            get(key) {
                return state[key];
            },
            set(key, value) {
                state[key] = value;
                return value;
            }
        },
        state
    };
}

function createMockDate(nowValue) {
    const RealDate = Date;
    const nowMs = typeof nowValue === "number" ? nowValue : new RealDate(nowValue).getTime();

    class MockDate extends RealDate {
        constructor(...args) {
            if (args.length === 0) {
                super(nowMs);
                return;
            }

            super(...args);
        }

        static now() {
            return nowMs;
        }

        static parse(value) {
            return RealDate.parse(value);
        }

        static UTC(...args) {
            return RealDate.UTC(...args);
        }
    }

    return MockDate;
}

function runFunctionNode(scriptPath, options = {}) {
    const absolutePath = path.resolve(scriptPath);
    const source = fs.readFileSync(absolutePath, "utf8");
    const contextStore = createStore(options.contextState);
    const flowStore = createStore(options.flowState);
    const globalStore = createStore(options.globalState);
    const statuses = [];
    const sentMessages = [];
    const errors = [];
    const sandbox = {
        msg: clone(options.msg) || {},
        context: contextStore.api,
        flow: flowStore.api,
        global: globalStore.api,
        env: options.env || {},
        node: {
            status(value) {
                statuses.push(clone(value));
            },
            send(value) {
                sentMessages.push(clone(value));
            },
            error(message, value) {
                errors.push({
                    message: clone(message),
                    msg: clone(value)
                });
            }
        },
        RED: options.RED || {},
        console,
        Date: createMockDate(options.now || "2026-04-06T12:00:00.000Z"),
        setInterval,
        clearInterval,
        setTimeout,
        clearTimeout
    };

    const script = new vm.Script(`(function () {\n${source}\n})();`, {
        filename: absolutePath
    });
    const result = script.runInNewContext(sandbox);

    return {
        result,
        msg: sandbox.msg,
        statuses,
        sentMessages,
        errors,
        contextState: contextStore.state,
        flowState: flowStore.state,
        globalState: globalStore.state
    };
}

module.exports = {
    runFunctionNode
};
