module.exports = {
    root: true,
    parser: '@typescript-eslint/parser',
    parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
    },
    env: {
        node: true,
        es2022: true,
    },
    extends: [
        'plugin:@typescript-eslint/recommended', // recommended rules from the @typescript-eslint/eslint-plugin
        'plugin:prettier/recommended', // eslint-plugin-prettier + eslint-config-prettier; must stay last in extends
    ],
    rules: {
        // External API payloads (Jupiter, DexScreener, Shyft, RPC errors) are loosely typed; flag `any` without failing lint.
        '@typescript-eslint/no-explicit-any': 'warn',
    },
    overrides: [
        {
            // Tests build partial fakes of SDK/connection objects with `as any`
            files: ['test/**/*.ts'],
            rules: { '@typescript-eslint/no-explicit-any': 'off' },
        },
    ],
};
