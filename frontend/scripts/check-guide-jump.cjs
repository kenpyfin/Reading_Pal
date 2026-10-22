const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '../src/utils/guideJump.js'), 'utf8');
const cjs = src.replace(/export function /g, 'function ');
const wrapped = `${cjs}
module.exports = {
  resolveGuideNavigationOffset,
  projectPageMarkdown,
  resolveGuideHighlightOnPage,
  markerOffsetInPageMarkdown,
  plainIndexForRaw,
};
`;
const mod = { exports: {} };
const run = new Function('module', 'exports', wrapped);
run(mod, mod.exports);

const {
  markerOffsetInPageMarkdown,
  projectPageMarkdown,
  resolveGuideHighlightOnPage,
  resolveGuideNavigationOffset,
} = mod.exports;

const clean = 'Alpha ends. Beta begins the section and continues.';
const betaAt = clean.indexOf('Beta');
assert.strictEqual(
  resolveGuideNavigationOffset(clean, betaAt),
  betaAt,
  'a clean opening stays on the stored start',
);

const fragment = 'The claim continues past the chunk boundary. Next sentence follows.';
const mid = fragment.indexOf('continues');
assert.strictEqual(
  resolveGuideNavigationOffset(fragment, mid),
  mid,
  'a mid-sentence start stays put instead of skipping toward the end',
);

const paragraph = 'Previous paragraph.\n\nFresh start stays.';
const freshAt = paragraph.indexOf('Fresh');
assert.strictEqual(resolveGuideNavigationOffset(paragraph, freshAt), freshAt);

const section = 'Opening of the section is here. The payoff quote sits at the end.';
const opening = resolveGuideHighlightOnPage({
  pageMarkdown: section,
  pageStartGlobal: 0,
  startOffset: 0,
  endOffset: section.length,
  quote: 'The payoff quote sits at the end.',
});
assert.ok(opening, 'the opening sentence is highlighted');
assert.ok(
  section.slice(opening.rawStart, opening.rawEnd).startsWith('Opening of the section'),
  'a later key quote is not the highlight',
);

const headed = '## Opening claim starts here. More follows after.';
const claim = resolveGuideHighlightOnPage({
  pageMarkdown: headed,
  pageStartGlobal: 0,
  startOffset: 0,
  endOffset: headed.length,
  quote: 'not in the text',
});
assert.ok(claim);
assert.strictEqual(headed[claim.rawStart], 'O');
assert.ok(!headed.slice(claim.rawStart, claim.rawEnd).includes('#'));

const withImage = 'Before ![diagram](figures/a.png) After the figure.';
const projected = projectPageMarkdown(withImage);
assert.ok(!projected.plain.includes('figures/a.png'));
assert.ok(projected.plain.includes('Before '));
assert.ok(projected.plain.includes('After the figure.'));

const pageOne = 'Section start stays on this page and runs long.';
const pageTwo = 'The ending sentence is here.';
const book = `${pageOne}${pageTwo}`;
const endOffset = book.length;
assert.strictEqual(markerOffsetInPageMarkdown(pageOne, 0, endOffset), null);
const markerOnNext = markerOffsetInPageMarkdown(pageTwo, pageOne.length, endOffset);
assert.strictEqual(markerOnNext, pageTwo.length);

const startHighlight = resolveGuideHighlightOnPage({
  pageMarkdown: pageOne,
  pageStartGlobal: 0,
  startOffset: 0,
  endOffset,
  quote: 'The ending sentence',
});
assert.ok(startHighlight);
assert.ok(pageOne.slice(startHighlight.rawStart, startHighlight.rawEnd).startsWith('Section start'));

console.log('guide jump checks passed');
