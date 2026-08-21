// Turn the settled mark (56-out-r-w52-soft.svg) into the files the app ships:
// the tile-less mark, the tab icon, the iOS icon, the favicon and the link card.
// Everything is derived from that one file, so re-picking means re-running this
// rather than editing anything under app/ or public/ by hand.
//
//   node design/logo/gen-app-assets.mjs   (from the repo root)
import { readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';

const SRC = 'design/logo/56-out-r-w52-soft.svg';
const CORAL = '#F2543D';
const src = readFileSync(SRC, 'utf8');

// The mark is drawn as coral shapes with black shapes laid over them, so the
// black is the tile showing through rather than ink. To lift it off the tile we
// re-run the same two stacks as a luminance mask (coral -> white, black stays
// black) and paint one coral rect through it, which leaves real holes.
const inner = src.match(/<g transform=[\s\S]*?<\/g>/)[0];
const asMask = inner.replaceAll(CORAL, '#FFFFFF');
const bare = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" role="img" aria-label="Ragurgitator">
  <title>Ragurgitator</title>
  <mask id="maw" maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="200">
  ${asMask}
  </mask>
  <rect width="200" height="200" fill="${CORAL}" mask="url(#maw)"/>
</svg>
`;
writeFileSync('public/mark.svg', bare);

const tile = src
  .replace('aria-label="Ragurgitator app tile"', 'aria-label="Ragurgitator"')
  .replace(/<title>[^<]*<\/title>/, '<title>Ragurgitator</title>');

// A tab is 16-20px, and at that size the outline's two coral lines merge into a
// smudge. Dropping the knockout stack leaves the same silhouette as a solid, and
// that is what survives the shrink — so the small icons use it while everything
// drawn at 24px or more keeps the mark as it was picked.
const solidInner = inner.split('\n').filter((l) => !l.includes('#000000')).join('\n') + '</g>';
const solid = tile.replace(inner, solidInner);
writeFileSync('app/icon.svg', tile);

const png = (size) => sharp(Buffer.from(tile), { density: 384 }).resize(size, size).png().toBuffer();

// iOS crops to its own superellipse, so it gets the tile with square corners —
// otherwise the home screen rounds an already-rounded tile twice.
const squared = tile.replaceAll(' rx="46"', '');
await sharp(Buffer.from(squared), { density: 384 }).resize(180, 180).png().toFile('app/apple-icon.png');

// favicon.ico for the browsers that still ask for one first. sharp can't write
// ICO, but the format is a small directory over whole PNG payloads.
const sizes = [16, 32, 48];
const pngs = await Promise.all(sizes.map(png));
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((s, i) => {
  const e = 6 + 16 * i;
  header.writeUInt8(s === 256 ? 0 : s, e); header.writeUInt8(s === 256 ? 0 : s, e + 1);
  header.writeUInt16LE(1, e + 4); header.writeUInt16LE(32, e + 6);
  header.writeUInt32LE(pngs[i].length, e + 8); header.writeUInt32LE(offset, e + 12);
  offset += pngs[i].length;
});
writeFileSync('app/favicon.ico', Buffer.concat([header, ...pngs]));

// Link card, for wherever the app gets shared. The bare mark rather than the
// tile: the card already supplies the black ground.
const og = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
  <rect width="1200" height="630" fill="#0B0C0A"/>
  <rect x="0" y="0" width="1200" height="8" fill="${CORAL}"/>
  <text x="452" y="330" font-family="Avenir Next, Helvetica Neue, sans-serif" font-size="82" font-weight="600" fill="#F7F4EF">Ragurgitator</text>
  <text x="452" y="396" font-family="Helvetica Neue, sans-serif" font-size="29" fill="#8E9683">A RAG workbench that measures its own retrieval.</text>
</svg>`;
await sharp(Buffer.from(og))
  .composite([{ input: await sharp(Buffer.from(bare), { density: 512 }).resize(300, 300).png().toBuffer(), left: 96, top: 165 }])
  .png()
  .toFile('app/opengraph-image.png');
writeFileSync('app/opengraph-image.alt.txt', 'The Ragurgitator mark — a coral R-shaped creature with an open, toothed mouth — beside the wordmark.\n');

console.log('wrote public/mark.svg, app/icon.svg, app/apple-icon.png, app/favicon.ico, app/opengraph-image.png');
