// Flat ESLint config for the Node backend. The React client has its own config
// under client/, so we ignore it here.
const js = require('@eslint/js');

module.exports = [
    {
        ignores: ['client/**', 'node_modules/**', 'dist/**', 'bin/**', 'cache/**', 'coverage/**', 'src-tauri/**']
    },
    js.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: {
                process: 'readonly',
                console: 'readonly',
                require: 'readonly',
                module: 'writable',
                __dirname: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly',
                Buffer: 'readonly'
            }
        },
        rules: {
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_|^next$' }]
        }
    },
    {
        files: ['tests/**/*.js'],
        languageOptions: {
            globals: {
                describe: 'readonly',
                it: 'readonly',
                expect: 'readonly',
                beforeEach: 'readonly',
                afterEach: 'readonly',
                beforeAll: 'readonly',
                afterAll: 'readonly',
                jest: 'readonly'
            }
        }
    }
];
