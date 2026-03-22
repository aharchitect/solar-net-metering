const js = require("@eslint/js");
const globals = require("globals");
const eslintConfigPrettier = require("eslint-config-prettier");

module.exports = [
    {
        ignores: ["node_modules/**", "dist/**"]
    },
    js.configs.recommended,
    {
        files: ["eslint.config.js"],
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "commonjs",
            globals: {
                ...globals.node
            }
        },
        rules: {
            "no-console": "off"
        }
    },
    {
        files: ["scripts/**/*.js"],
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "commonjs",
            globals: {
                ...globals.node
            }
        },
        rules: {
            "no-console": "off"
        }
    },
    {
        files: ["function-nodes/**/*.js"],
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "script",
            parserOptions: {
                ecmaFeatures: {
                    globalReturn: true
                }
            },
            globals: {
                msg: "readonly",
                context: "readonly",
                flow: "readonly",
                global: "readonly",
                env: "readonly",
                node: "readonly",
                RED: "readonly",
                setInterval: "readonly",
                clearInterval: "readonly",
                setTimeout: "readonly",
                clearTimeout: "readonly"
            }
        },
        rules: {
            "no-console": "off",
            "no-unused-vars": ["warn", { args: "none", ignoreRestSiblings: true }]
        }
    },
    eslintConfigPrettier
];
