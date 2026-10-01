import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores(["dist/", "coverage/"]),
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["*.ts"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Errors are rewrapped on purpose so that logs and tool results do not
      // carry credentials or raw payloads from the original error.
      "preserve-caught-error": "off",
      // Boundary data is validated with zod or explicit checks; these rules
      // mostly report Node's Buffer<any> and JSON.parse results.
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      // Context values and helpers are declared as methods but never use this.
      "@typescript-eslint/unbound-method": "off",
      // Its fixes remove assertions that noUncheckedIndexedAccess needs.
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      // Async functions without await keep interfaces and callers uniform.
      "@typescript-eslint/require-await": "off",
      // Rejection values pass through from Node and SDK callbacks unchanged.
      "@typescript-eslint/prefer-promise-reject-errors": "off",
      // Closures may read a variable before its single assignment.
      "prefer-const": ["error", { ignoreReadBeforeAssign: true }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ["*.js", "*.ts", "src/**", "test/**", "scripts/**"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["ui/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
    languageOptions: { globals: globals.browser },
  },
);
