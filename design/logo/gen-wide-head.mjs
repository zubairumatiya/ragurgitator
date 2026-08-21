// Widen the outlined-R head to the right: head becomes an ellipse whose LEFT edge
// stays pinned where the circle's was, so every extra unit of width goes rightward.
const RY = 48, CY = 74, LEFT = 60;          // approved head: circle r48 at (108,74)
const V = [80, 74];                          // throat vertex, held fixed
const SIN = 31.5 / 48;                       // mouth corners sit at this parametric angle
const COS = Math.sqrt(1 - SIN * SIN);

// The approved teeth, read back off the file you picked, so each new head is laid
// out with the same rhythm rather than redrawn by hand.
const APPROVED = {
  upper: { C: [144.2, 42.5], t: [
    [[144.3,42.5],[143.5,57.2],[131.3,48.8]],
    [[128.2,50.4],[126.9,62.4],[116.6,56.1]],
    [[112.2,58.2],[110.3,67.5],[101.8,63.3]]] },
  lower: { C: [144.2, 105.5], t: [
    [[136.2,101.6],[135.2,88.2],[124,95.6]],
    [[120.2,93.7],[118.6,83.1],[109.2,88.3]],
    [[104.1,85.8],[102,77.9],[94.4,81.1]]] },
};

const sub = (a,b) => [a[0]-b[0], a[1]-b[1]];
const len = v => Math.hypot(v[0], v[1]);

// Jaw frame: s runs from the mouth corner toward the throat, h runs into the mouth.
function frame(C, sign) {
  const d = sub(V, C), L = len(d), u = [d[0]/L, d[1]/L];
  return { L, u, n: [sign * u[1], -sign * u[0]] };
}
const toSH = (p, C, f) => {
  const d = sub(p, C);
  return [(d[0]*f.u[0] + d[1]*f.u[1]) / f.L, (d[0]*f.n[0] + d[1]*f.n[1]) / f.L];
};
const toXY = ([s,h], C, f) => [
  +(C[0] + s*f.L*f.u[0] + h*f.L*f.n[0]).toFixed(1),
  +(C[1] + s*f.L*f.u[1] + h*f.L*f.n[1]).toFixed(1)];

// Every tooth stored as fractions of jaw length, so it rides the jaw when the head grows.
const norm = {};
for (const [jaw, sign] of [['upper', -1], ['lower', 1]]) {
  const f = frame(APPROVED[jaw].C, sign);
  norm[jaw] = APPROVED[jaw].t.map(t => t.map(p => toSH(p, APPROVED[jaw].C, f)));
}

// `ryTop` raises only the dome: the skull is drawn as two half-ellipses that meet at the
// leftmost point, which sits behind the body stem, so the curvature break there is never seen.
// `lip` rounds the lower mouth corner off by that many units instead of leaving it a spike.
function head(rx, toothScale = 1, prop = false, ryTop = RY, lip = 0) {
  const cx = LEFT + rx;
  const cosTop = Math.sqrt(1 - (31.5 / ryTop) ** 2);
  const up = [+(cx + rx*cosTop).toFixed(1), CY - 31.5];
  const lo = [+(cx + rx*COS).toFixed(1), CY + 31.5];
  const r1 = (n) => +n.toFixed(1);
  const dome = `A ${rx} ${ryTop} 0 0 0 ${LEFT} ${CY} A ${rx} ${RY} 0 0 0`;

  let body;
  if (lip > 0) {
    // Leave the arc `lip` short of the corner, rejoin the jaw `lip` past it, and bridge the
    // two with a quadratic that still leans on the original point.
    const t1 = Math.atan2(31.5 / RY, (lo[0] - cx) / rx);
    const speed = Math.hypot(rx * Math.sin(t1), RY * Math.cos(t1));
    const t = t1 + lip / speed;
    const A = [r1(cx + rx*Math.cos(t)), r1(CY + RY*Math.sin(t))];
    const d = sub(V, lo), n = len(d);
    const B = [r1(lo[0] + lip*d[0]/n), r1(lo[1] + lip*d[1]/n)];
    body = `M ${up[0]} ${up[1]} ${dome} ${A[0]} ${A[1]} Q ${lo[0]} ${lo[1]} ${B[0]} ${B[1]} L ${V[0]} ${V[1]} Z`;
  } else {
    body = `M ${up[0]} ${up[1]} ${dome} ${lo[0]} ${lo[1]} L ${V[0]} ${V[1]} Z`;
  }

  const teeth = [];
  for (const [jaw, sign, C] of [['upper', -1, up], ['lower', 1, lo]]) {
    const f = frame(C, sign);
    for (const t of norm[jaw]) {
      // Scale each tooth about its own base midpoint so the rhythm along the jaw holds.
      const k = toothScale * (prop ? 1 : 71.51 / f.L);   // 'prop' lets teeth grow with the jaw
      // Anchor each tooth on its leading edge, not its base midtooth: the first upper tooth
      // starts life on the mouth corner, and scaling about the midpoint walked it inboard —
      // enough that its rounded join and the corner's stopped sharing an outer edge.
      const a0 = t[0][0];
      const pts = t.map(([s,h]) => toXY([a0 + (s-a0)*k, h*k], C, f));
      teeth.push(`M ${pts[0].join(' ')} L ${pts[1].join(' ')} L ${pts[2].join(' ')} Z`);
    }
  }
  return { body, teeth: teeth.join(' ') };
}

const TAIL = 'M72 113.8 Q 111.8 127.9 152 170';
function mark(id, rx, toothScale = 1, prop = false, ryTop = RY, lip = 0) {
  const h = head(rx, toothScale, prop, ryTop, lip);
  return `<symbol id="${id}" viewBox="0 0 200 200">
<defs><clipPath id="clip-${id}"><rect width="200" height="200" rx="46"/></clipPath></defs>
  <rect width="200" height="200" rx="46" fill="#000000"/>
  <g clip-path="url(#clip-${id})">
  <g transform="translate(-1.8 -0.9) scale(1)"><path d="${TAIL}" stroke="#F2543D" stroke-width="30" stroke-linecap="round" fill="none"/>
  <path d="${TAIL}" stroke="#F2543D" stroke-width="40" stroke-linecap="round" fill="none"/>
  <rect x="41" y="39" width="42" height="136" rx="21" fill="#F2543D"/>
  <path d="${h.body}" fill="#F2543D" stroke="#F2543D" stroke-width="10" stroke-linejoin="round"/>
  <path d="${h.teeth}" fill="#F2543D" stroke="#F2543D" stroke-width="10" stroke-linejoin="round"/>
  <path d="${TAIL}" stroke="#000000" stroke-width="30" stroke-linecap="round" fill="none"/>
  <rect x="46" y="44" width="32" height="126" rx="16" fill="#000000"/>
  <path d="${h.body}" fill="#000000" stroke="#000000" stroke-width="0.8" stroke-linejoin="round"/>
  <path d="${h.teeth}" fill="#000000"/></g>
  </g>
</symbol>`;
}

// Round eight: the head pushed rightward. rx is the head's horizontal radius (48 = approved);
// `prop` lets the teeth grow with the lengthened jaw instead of holding their approved size.
export const WIDE = [
  ['55-out-r-w52', 'out-r-w52', 52, false],
  ['50-out-r-w54', 'out-r-w54', 54, false],
  ['51-out-r-w58', 'out-r-w58', 58, false],
  ['52-out-r-w62', 'out-r-w62', 62, false],
  ['53-out-r-w58-teeth', 'out-r-w58-teeth', 58, true],
  ['54-out-r-w62-teeth', 'out-r-w62-teeth', 62, true],
  // Round nine: the 52 head with a taller dome and the lower lip taken off the point.
  ['56-out-r-w52-soft', 'out-r-w52-soft', 52, false, 54, 5],
  ['59-out-r-w52-lip6', 'out-r-w52-lip6', 52, false, 54, 6],
  ['60-out-r-w52-lip7', 'out-r-w52-lip7', 52, false, 54, 7],
  ['57-out-r-w52-round', 'out-r-w52-round', 52, false, 54, 8],
  ['58-out-r-w52-rounder', 'out-r-w52-rounder', 52, false, 56, 11],
];
export { mark, head };
