import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rule = require('../../tools/eslint/no-unsafe-innerhtml.js');

describe('no-unsafe-innerhtml ESLint rule', () => {
  // ESLint 9 RuleTester uses flat-config shape: languageOptions (not top-level parserOptions).
  const tester = new RuleTester({
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
  });

  it('flags dynamic innerHTML assignment and allows literal innerHTML assignment', () => {
    tester.run('no-unsafe-innerhtml', rule, {
      valid: [
        {
          code: `el.innerHTML = '<p>literal</p>';`,
        },
        {
          code: `el.innerHTML = \`<p>static</p>\`;`,
        },
      ],
      invalid: [
        {
          code: `el.innerHTML = content;`,
          errors: [{ messageId: 'unsafeInnerHtml' }],
        },
        {
          code: `el.outerHTML = userInput;`,
          errors: [{ messageId: 'unsafeInnerHtml' }],
        },
        {
          code: `el.innerHTML = sanitize(content);`,
          errors: [{ messageId: 'unsafeInnerHtml' }],
        },
        {
          code: `el.innerHTML = \`<p>\${content}</p>\`;`,
          errors: [{ messageId: 'unsafeInnerHtml' }],
        },
      ],
    });
  });
});
