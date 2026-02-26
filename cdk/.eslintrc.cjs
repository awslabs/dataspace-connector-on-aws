module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: {
    project: ["tsconfig.json"],
  },
  plugins: ["@typescript-eslint"],
  extends: ["plugin:@typescript-eslint/recommended", "prettier"],
  // For the list of rules supported by @typescript-eslint/eslint-plugin,
  // see: https://typescript-eslint.io/rules/
  rules: {},
};
