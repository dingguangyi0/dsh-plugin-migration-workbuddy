import { defineConfig } from 'tsdown'

const PACKAGE_NAME = 'dsh-plugin-migration-workbuddy'
const EXTERNALS = new Set([
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-slots',
])

export default defineConfig([
  {
    name: `${PACKAGE_NAME}/host`, entry: { index: 'src/index.ts' }, tsconfig: 'tsconfig.json', outDir: 'lib',
    format: 'esm', platform: 'node', target: 'es2022', fixedExtension: false, dts: false, sourcemap: true,
    external: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-host-webserver', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-persistence', '@deepseek-ai/dsh-workspace', '@deepseek-ai/dsh-llm', '@deepseek-ai/schemastery'],
  },
  {
    name: `${PACKAGE_NAME}/client`, entry: { client: 'src/client/index.ts' }, tsconfig: 'tsconfig.client.json', outDir: 'lib',
    format: 'cjs', platform: 'browser', target: 'es2022', fixedExtension: false, dts: false, sourcemap: true,
    deps: { neverBundle: specifier => EXTERNALS.has(specifier) || specifier.endsWith('/client') },
    outputOptions: { entryFileNames: 'client.js', banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`, footer: 'return module.exports; } });' },
  },
])
