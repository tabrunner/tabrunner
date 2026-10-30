import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/.wxt/**",
      "**/dist/**",
      "**/dist-ssr/**",
      "**/node_modules/**",
      "**/.turbo/**",
      ".cache/**",
      ".claude/**",
      ".agents/**",
      "**/preview/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["apps/extension/**/*.{ts,tsx}"],
    rules: reactHooks.configs["recommended-latest"].rules,
    languageOptions: {
      globals: { ...globals.browser, chrome: "readonly" },
    },
  },
  {
    files: ["apps/site/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    files: ["scripts/**/*.ts", "apps/*/scripts/**/*.ts", "packages/mcp/**/*.ts"],
    languageOptions: {
      globals: { ...globals.node, Bun: "readonly", WebSocket: "readonly" },
    },
  },
  {
    // Keep React and UI stores out of the extension's service worker.
    files: ["apps/extension/**/*.{ts,tsx}"],
    ignores: [
      "apps/extension/**/ui/**",
      "apps/extension/src/components/**",
      "apps/extension/**/entrypoints/**",
      "apps/extension/src/i18n/ui.ts",
      "apps/extension/**/__tests__/**",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "react", message: "React is UI-only. Import it from a ui/ folder." },
            { name: "react-dom", message: "React is UI-only. Import it from a ui/ folder." },
            { name: "zustand", message: "zustand is UI-only. Import it from a ui/ folder." },
            {
              name: "react-i18next",
              message: "react-i18next is UI-only. Import it from a ui/ folder.",
            },
          ],
          patterns: [
            {
              group: ["react/*", "react-dom/*"],
              message: "React is UI-only. Import it from a ui/ folder.",
            },
            { group: ["*/ui/*"], message: "Import UI modules from a ui/ folder." },
          ],
        },
      ],
    },
  },
  {
    // Static imports delay the first side-panel load. The app loads by import().
    files: ["apps/extension/src/entrypoints/sidepanel/shell.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: ".",
              message:
                "The panel stays hidden until this file loads. Use import() afterward (see shell.ts).",
            },
          ],
        },
      ],
    },
  },
);
