// @ts-check

import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
// @ts-expect-error not typed
import { dirname } from 'path';
// @ts-expect-error not typed
import { fileURLToPath } from 'url';

export default defineConfig(
  eslint.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["*.mjs", "*.js", "*.config.*"]
        },
        tsconfigRootDir: dirname(fileURLToPath(import.meta.url)),
      },
    },
  },
  {
    files: ['**/*.js', '**/*.mjs', '*.config.*'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
