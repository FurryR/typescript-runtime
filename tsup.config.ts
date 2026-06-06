import type { Plugin } from 'esbuild';
import { defineConfig } from 'tsup';

const externalPresetJson: Plugin = {
  name: 'external-babel-preset-json',
  setup(build) {
    build.onResolve({ filter: /@babel\/.*\/package\.json$/ }, () => ({
      external: true,
    }));
    build.onResolve({ filter: /^fs$|^path$|^module$/ }, () => ({
      external: true,
    }));
  },
};

export default defineConfig({
  entry: { 'typescript-runtime': 'src/index.ts' },
  format: ['iife'],
  globalName: 'typescriptRuntimeInternal',
  clean: true,
  dts: false,
  minify: true,
  sourcemap: true,
  platform: 'browser',
  target: 'es2020',
  outDir: 'dist',
  noExternal: ['@babel/*'],
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  banner: {
    js: 'var process=typeof process=="undefined"?{env:{NODE_ENV:"production"}}:process;',
  },
  esbuildPlugins: [externalPresetJson],
  outExtension() {
    return { js: '.global.js' };
  },
});
