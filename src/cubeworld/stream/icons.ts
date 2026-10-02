/** 12 x 12 pixel icons for the theme buttons ('#' is ink). No text anywhere on the buttons. */
const ICONS: Readonly<Record<string, readonly string[]>> = {
  // a street lamp
  pole: [
    '...######...',
    '..########..',
    '..#......#..',
    '..#.####.#..',
    '...######...',
    '.....##.....',
    '.....##.....',
    '.....##.....',
    '.....##.....',
    '.....##.....',
    '....####....',
    '...######...',
  ],
  // Tokyo Tower's lattice
  tower: [
    '.....##.....',
    '.....##.....',
    '.....##.....',
    '....#..#....',
    '....####....',
    '....#..#....',
    '...######...',
    '...#.##.#...',
    '..########..',
    '..#.#..#.#..',
    '.##.#..#.##.',
    '.#..#..#..#.',
  ],
  // a house on a slope
  house: [
    '.......##...',
    '......####..',
    '.....######.',
    '....########',
    '...##.####..',
    '..##..#..#..',
    '.##...#..#..',
    '##....####..',
    '#...........',
    '............',
    '............',
    '............',
  ],
  // a hill with a tower on top
  hill: [
    '.......#....',
    '.......#....',
    '......###...',
    '......###...',
    '.....#####..',
    '....#######.',
    '...#########',
    '..##########',
    '.###########',
    '############',
    '############',
    '............',
  ],
  // waves
  water: [
    '............',
    '............',
    '..##....##..',
    '.#..#..#..#.',
    '#....##....#',
    '............',
    '..##....##..',
    '.#..#..#..#.',
    '#....##....#',
    '............',
    '............',
    '............',
  ],
};

/** A canvas with the icon drawn pixel by pixel; scale it with CSS (image-rendering: pixelated). */
export function iconCanvas(name: string, ink = '#0b0b0b'): HTMLCanvasElement {
  const rows = ICONS[name] ?? ICONS.hill;
  const canvas = document.createElement('canvas');
  canvas.width = 12;
  canvas.height = 12;
  canvas.style.cssText = 'width:36px;height:36px;image-rendering:pixelated;display:block;pointer-events:none';
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.fillStyle = ink;
  rows.forEach((row, y) => {
    for (let x = 0; x < 12; x++) if (row[x] === '#') ctx.fillRect(x, y, 1, 1);
  });
  return canvas;
}
