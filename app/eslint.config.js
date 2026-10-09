/**
 * Static Rules-of-Hooks gate.
 *
 * This exists because two real crashes shipped in versionCode 8, both of
 * which this config flags statically:
 *   1. app/app/_layout.tsx — a `useStore(everConnected)` below the
 *      `if (!cfg)` early return → "Rendered more hooks than the previous
 *      render" → fatal at every cold open for paired users.
 *   2. app/src/components/media/AudioBubble.tsx — a `useStyles(...)` call
 *      inside a useEffect callback → "Invalid hook call" on first
 *      auto-play of a downloaded voice note.
 *
 * `react-hooks/rules-of-hooks` is the load-bearing rule (error). It treats
 * any `useXxx` call inside a component/hook as a tracked hook, including
 * nanostores' `useStore` and this repo's `useStyles`/`useShape`, and fails
 * on hooks called conditionally, after early returns, or inside callbacks.
 * Never downgrade or disable this rule repo-wide; per-line disables must
 * get a justification comment.
 *
 * `npm run lint` is chained into `npm run verify` — keep it green.
 */
const tsParser = require('@typescript-eslint/parser')
const tsPlugin = require('@typescript-eslint/eslint-plugin')
const reactHooks = require('eslint-plugin-react-hooks')

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'android/**',
      'ios/**',
      '.expo/**',
      'scripts/**',
      'mocks/**',
    ],
  },
  {
    files: ['**/*.{js,jsx,mjs,cjs}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      '@typescript-eslint': tsPlugin,
    },
    languageOptions: { parser: tsParser },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Registered (but off) so the repo's intentional require() sites can
      // carry per-line disable directives without "rule not found" errors.
      // This codebase deliberately uses require() for lazy loads that must
      // stay out of static import graphs (gateway.ts, push.ts) — policing
      // import style is not this config's job; hook discipline is.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
]
