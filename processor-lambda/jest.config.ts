/*
 * For a detailed explanation regarding each configuration property and type check, visit:
 * https://jestjs.io/docs/configuration
 *
 * `yarn unit` runs only the hermetic tests in test/unit. The end-to-end suite in test/e2e needs AWS
 * credentials, production secrets, a funded wallet and live RPC/Jupiter/Telegram access, and executes
 * real swaps, so it only runs when RUN_E2E=1 is set (`yarn test:e2e`).
 */
const runE2e = process.env.RUN_E2E === '1';

export default {
    preset: 'ts-jest',
    testEnvironment: 'node',
    clearMocks: true,
    coverageDirectory: 'coverage',
    coverageProvider: 'v8',
    testMatch: runE2e ? ['<rootDir>/test/e2e/**/*.test.ts'] : ['<rootDir>/test/unit/**/*.test.ts'],
    // The unit suite blocks sockets/fetch so a missing mock fails instead of touching the network
    setupFiles: runE2e ? [] : ['<rootDir>/test/setup/hermetic.ts'],
};
