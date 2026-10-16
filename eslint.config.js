const { defineConfig } = require("eslint/config");
const raycastConfig = require("@raycast/eslint-config");

module.exports = defineConfig([
  ...raycastConfig,
  {
    // Fake CLIs that tests start as plain Node scripts, so they stay CommonJS.
    files: ["tests/fixtures/**/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
]);
