/**
 * Dev utility: render every track from shared/tracks.ts as ASCII art so
 * layout changes can be reviewed without booting the app.
 *
 *   npx tsx scripts/render-tracks.ts [trackId]
 *
 * Legend: '·' grass · '#' track · 'F' finish · 'S' start slot · '+' checkpoint zone (on grass)
 */
import { TRACKS } from '../shared/tracks';

const only = process.argv[2];

for (const track of TRACKS) {
  if (only && track.id !== only) continue;
  const chars: string[][] = track.grid.map((row) =>
    row.map((t) => (t === 'grass' ? '·' : t === 'finish' ? 'F' : '#'))
  );
  for (const s of track.startLine) {
    if (chars[s.y]?.[s.x] !== undefined) chars[s.y][s.x] = 'S';
  }
  const cp = track.checkpoint;
  if (cp) {
    for (let y = cp.y0; y <= cp.y1; y++) {
      for (let x = cp.x0; x <= cp.x1; x++) {
        if (chars[y]?.[x] === '·') chars[y][x] = '+';
      }
    }
  }
  console.log(`\n=== ${track.id} (${track.width}x${track.height}) ===`);
  const header = Array.from({ length: track.width }, (_, x) => `${x % 10}`).join('');
  console.log('   ' + header);
  chars.forEach((row, y) => {
    console.log(String(y).padStart(2, ' ') + ' ' + row.join(''));
  });

  // Sanity: every drivable cell reachable from the first start slot, and
  // every start slot on track.
  const seen = new Set<string>();
  const queue = [track.startLine[0]];
  seen.add(`${queue[0].x},${queue[0].y}`);
  while (queue.length) {
    const { x, y } = queue.pop()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      const tile = track.grid[ny]?.[nx];
      if ((tile === 'track' || tile === 'finish') && !seen.has(`${nx},${ny}`)) {
        seen.add(`${nx},${ny}`);
        queue.push({ x: nx, y: ny });
      }
    }
  }
  let drivable = 0;
  for (const row of track.grid) for (const t of row) if (t !== 'grass') drivable++;
  const badSlots = track.startLine.filter((s) => track.grid[s.y]?.[s.x] === 'grass');
  console.log(
    `reachable ${seen.size}/${drivable} drivable cells · ` +
      `${badSlots.length ? `START SLOTS ON GRASS: ${badSlots.length}` : 'all start slots on track'}`
  );
}
