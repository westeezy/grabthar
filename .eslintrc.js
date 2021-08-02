module.exports = {
    extends: "./node_modules/grumbler-scripts/config/.eslintrc-node.js",
    globals: {
        NodeJS: true,
    },
    rules: {
        "require-atomic-updates": "off",
        "no-warning-comments": "off",
    },
};
