import tseslint from "@typescript-eslint/eslint-plugin";
import prettier from "eslint-config-prettier";

export default [
  ...tseslint.configs["flat/recommended"],
  prettier,
  { rules: { "@typescript-eslint/no-empty-object-type": "off" } },
];
