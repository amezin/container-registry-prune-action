import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import json from '@eslint/json';
import markdown from '@eslint/markdown';
import prettierRecommended from 'eslint-plugin-prettier/recommended';
import yml from 'eslint-plugin-yml';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
    globalIgnores(['dist/'], 'dist'),
    {
        files: ['**/*.{js,mjs,cjs,ts,mts,cts}'],
        plugins: { js },
        extends: ['js/recommended'],
        languageOptions: { globals: globals.node },
    },
    {
        files: ['**/*.{ts,mts,cts}'],
        plugins: { tseslint },
        extends: ['tseslint/strictTypeChecked'],
        languageOptions: {
            parserOptions: {
                projectService: true,
            },
        },
        rules: {
            '@typescript-eslint/no-unused-vars': [
                'error',
                {
                    argsIgnorePattern: '^_',
                    caughtErrorsIgnorePattern: '^_',
                    destructuredArrayIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                },
            ],
        },
    },
    {
        files: ['**/*.json'],
        plugins: { json },
        language: 'json/json',
        extends: ['json/recommended'],
    },
    {
        files: ['package-lock.json'],
        rules: {
            'json/no-empty-keys': 'off',
        },
    },
    {
        files: ['**/*.md'],
        plugins: { markdown },
        language: 'markdown/gfm',
        extends: ['markdown/recommended'],
    },
    {
        files: ['**/*.yaml', '**/*.yml'],
        plugins: { yml },
        extends: ['yml/flat/recommended', 'yml/flat/prettier'],
    },
    {
        files: ['.github/workflows/*.{yml,yaml}'],
        rules: {
            'yml/no-empty-mapping-value': 'off',
        },
    },
    prettierRecommended,
]);
