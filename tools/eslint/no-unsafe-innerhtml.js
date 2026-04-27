'use strict';

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow innerHTML/outerHTML assignment with a non-literal RHS. ' +
        'Use MarkdownRenderer.render() for user content instead.',
      category: 'Security',
      recommended: true,
    },
    schema: [],
    messages: {
      unsafeInnerHtml:
        'Unsafe assignment to {{prop}}: RHS must be a string literal. ' +
        'Use MarkdownRenderer.render() for dynamic content.',
    },
  },

  create(context) {
    /**
     * Returns true when the node is a "safe" (fully-static) value:
     *   - StringLiteral            e.g.  el.innerHTML = '<p>hi</p>'
     *   - TemplateLiteral with no  e.g.  el.innerHTML = `<p>static</p>`
     *     expressions (quasis only)
     */
    function isSafeLiteral(node) {
      if (node.type === 'Literal' && typeof node.value === 'string') {
        return true;
      }
      if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
        return true;
      }
      return false;
    }

    return {
      AssignmentExpression(node) {
        const { left, right } = node;

        // Only care about MemberExpression on the LHS
        if (left.type !== 'MemberExpression') return;

        const prop = left.property;
        const propName =
          prop.type === 'Identifier'
            ? prop.name
            : prop.type === 'Literal'
            ? String(prop.value)
            : null;

        if (propName !== 'innerHTML' && propName !== 'outerHTML') return;

        if (!isSafeLiteral(right)) {
          context.report({
            node,
            messageId: 'unsafeInnerHtml',
            data: { prop: propName },
          });
        }
      },
    };
  },
};

module.exports = rule;
