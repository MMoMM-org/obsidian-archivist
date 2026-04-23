// ESM entry point for flat-config consumption.
// eslint.config.mjs imports this file to avoid relying on CJS/ESM interop.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rule = require('./no-unsafe-innerhtml.js');

export default {
  rules: {
    'no-unsafe-innerhtml': rule,
  },
};
