module.exports = {
  env: { node: true, es2021: true },
  extends: ["eslint:recommended"],
  parserOptions: { project: "./tsconfig.json" },
  ignorePatterns: ["node_modules/", ".vercel/", ".seros/", ".env*", "*.db"],
  rules: {
    eqeqeq: ["error", "always"],
    "no-console": ["warn", { allow: ["error", "warn", "info"] }],
    "no-unused-vars": "error",
    "no-var": "error",
    "prefer-const": "error",
    semi: ["error", "always"],
    quotes: ["error", "double"],
    indent: ["error", 2],
    "max-len": ["warn", { code: 120, tabWidth: 2, ignoreComments: true }]
  }
};