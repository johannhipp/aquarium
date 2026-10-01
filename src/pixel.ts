const SVG_NS = 'http://www.w3.org/2000/svg';

/** Hand-drawn pixel art: one `X` per filled pixel, drawn as crisp SVG rects (never a font glyph). */
/** `scale` is CSS pixels per art pixel; whole numbers keep every pixel crisp on 1x, 2x and 3x screens. */
export function pixelSvg(rows: readonly string[], scale: number): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${rows[0].length} ${rows.length}`);
  svg.setAttribute('width', String(rows[0].length * scale));
  svg.setAttribute('height', String(rows.length * scale));
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('aria-hidden', 'true');
  rows.forEach((row, y) => {
    [...row].forEach((cell, x) => {
      if (cell !== 'X') return;
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('x', String(x));
      rect.setAttribute('y', String(y));
      rect.setAttribute('width', '1');
      rect.setAttribute('height', '1');
      svg.appendChild(rect);
    });
  });
  return svg;
}
