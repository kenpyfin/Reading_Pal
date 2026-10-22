const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '../src/utils/pageBoundaries.js'), 'utf8');
const cjs = src.replace(/export function /g, 'function ').replace(/export const /g, 'const ');
const wrapped = `${cjs}
module.exports = { calculatePageBoundaries, MAX_PAGE_BUDGET, SCREEN_CHARS };
`;
const mod = { exports: {} };
const run = new Function('module', 'exports', wrapped);
run(mod, mod.exports);

const { calculatePageBoundaries, MAX_PAGE_BUDGET } = mod.exports;
assert.strictEqual(MAX_PAGE_BUDGET, 6000);

function covers(markdown, boundaries) {
  assert.strictEqual(boundaries[0].start, 0);
  assert.strictEqual(boundaries[boundaries.length - 1].end, markdown.length);
  for (let i = 1; i < boundaries.length; i += 1) {
    assert.strictEqual(boundaries[i - 1].end, boundaries[i].start);
    assert.ok(boundaries[i].end > boundaries[i].start);
  }
}

const longWord = 'a'.repeat(7000);
const wordPages = calculatePageBoundaries(longWord, 6000);
covers(longWord, wordPages);
assert.strictEqual(wordPages[0].end, 6000, 'a long word stops at the cap');

const image = '![](/images/app/a.png)';
const oneScreen = `${'b'.repeat(3000)}${image}${'c'.repeat(3000)}`;
const oneScreenPages = calculatePageBoundaries(oneScreen, 6000);
covers(oneScreen, oneScreenPages);
assert.strictEqual(oneScreenPages[0].end, 3000 + image.length, 'one screen of text plus one image');

const overflow = `${'d'.repeat(3001)}${image}`;
const overflowPages = calculatePageBoundaries(overflow, 6000);
covers(overflow, overflowPages);
assert.strictEqual(overflowPages[0].end, 3001, 'an image that does not fit starts the next page');

const images = [
  '![](/images/app/a.png)',
  '![](/images/app/b.png)',
  '![](/images/app/c.png)',
].join('\n\n');
const imagePages = calculatePageBoundaries(images, 6000);
covers(images, imagePages);
const thirdAt = images.indexOf('![](/images/app/c.png)');
const firstPage = images.slice(0, imagePages[0].end);
assert.ok(firstPage.includes('a.png') && firstPage.includes('b.png'), 'two images fill a page');
assert.ok(!firstPage.includes('c.png') && imagePages[0].end <= thirdAt, 'the third image starts a new page');

const fenced = `${'e'.repeat(5900)}\n\`\`\`\n${'code '.repeat(100)}\n\`\`\`\n`;
const fenceAt = fenced.indexOf('```');
const fencePages = calculatePageBoundaries(fenced, 6000);
covers(fenced, fencePages);
assert.ok(fencePages[0].end <= fenceAt, 'an open fence does not push past the cap');
assert.ok(fencePages[0].end <= 6000);

const chapterBody = `${'word '.repeat(1000)}\nChapter 2\n${'tail '.repeat(400)}`;
const chapterAt = chapterBody.indexOf('Chapter 2');
const chapterPages = calculatePageBoundaries(chapterBody, 6000);
covers(chapterBody, chapterPages);
assert.ok(chapterPages.some((boundary) => boundary.start === chapterAt), 'a nearby chapter starts the next page');

console.log('page boundary checks passed');
