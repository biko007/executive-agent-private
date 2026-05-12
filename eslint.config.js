import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

// Custom rule: enforce module boundary — only import from <module>/index.ts
const moduleGuardPlugin = {
  rules: {
    'no-deep-module-import': {
      meta: {
        type: 'problem',
        docs: { description: 'Disallow importing module internals — use <module>/index.ts' },
        messages: {
          deepImport: 'Import only from <module>/index.ts — module internals are private. Got: {{source}}',
        },
      },
      create(context) {
        return {
          ImportDeclaration(node) {
            const source = node.source.value;
            // Match any import containing /modules/<name>/<file> where <file> is NOT index
            if (/\/modules\/[^/]+\/(?!index(?:\.[jt]sx?)?$)[^/]+/.test(source)) {
              context.report({ node, messageId: 'deepImport', data: { source } });
            }
          },
        };
      },
    },
  },
};

export default [
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      'openclaw': moduleGuardPlugin,
    },
    rules: {
      'openclaw/no-deep-module-import': 'error',
    },
  },
];
