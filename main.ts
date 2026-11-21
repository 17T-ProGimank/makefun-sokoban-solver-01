// Sokoban solver: push-optimal A* over rooms, written from scratch.
//
// A level is a hallway with 1-4 rooms off it; a box pushed out of a room's
// door into the hallway is lost, so every room is an independent problem and
// the level's push-optimal count is the sum of its rooms' optima. The solver
// therefore splits the level into rooms, solves each room push-optimally and
// stitches the moves together (the player walks the hallway between rooms).
//
// Each room is solved by A* over pushes (not single steps): a state is the
// boxes' squares plus the player's reachable region (named by its lowest
// square). The estimate is the Hungarian assignment of boxes to goals over
// walking distances (admissible: every box must be pushed at least its
// distance to its goal), and two deadlocks are pruned: a box on a square
// from which no push sequence reaches a goal (live-squares analysis), and a
// frozen 2x2 block of walls and boxes holding a box off its goal. The search
// budget is counted in states, never the clock, so two runs agree byte for
// byte. When A* gives up on a room, a plain push-BFS (the same search with a
// zero estimate) gets a second chance before the room is left unsolved.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
/** States one room search may keep before it gives up (work, never the clock). */
const MAX_STATES = 500_000;

const DIRS: [number, number, string, string][] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

type Level = { w: number; h: number; wall: Uint8Array; goals: number[]; boxes: number[]; player: number };
type Solved = { pushes: number; moves: string };

/** Parse XSB text: # wall, space floor, . goal, $ box, * box on goal, @ player, + player on goal. */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/** Squares from which a box alone can be pushed onto some goal (pulled back from the goals over open floor). */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (y < 0 || y >= wall.length) continue;
      const behind = y - d;
      if (behind < 0 || behind >= wall.length) continue;
      if (!wall[y] && !wall[behind] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * The squares the player reaches from `from` around walls and the boxes in
 * `occupied`, marked in `seen` with `stamp`; returns the region's lowest square.
 */
function reach(level: Level, occupied: Uint8Array, from: number, seen: Int32Array, stamp: number, stack: Int32Array): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    // up, down, left, right
    const q0 = p - w;
    const q1 = p + w;
    const q2 = p - 1;
    const q3 = p + 1;
    if (wall[q0] === 0 && occupied[q0] === 0 && seen[q0] !== stamp) { seen[q0] = stamp; stack[n++] = q0; }
    if (wall[q1] === 0 && occupied[q1] === 0 && seen[q1] !== stamp) { seen[q1] = stamp; stack[n++] = q1; }
    if (wall[q2] === 0 && occupied[q2] === 0 && seen[q2] !== stamp) { seen[q2] = stamp; stack[n++] = q2; }
    if (wall[q3] === 0 && occupied[q3] === 0 && seen[q3] !== stamp) { seen[q3] = stamp; stack[n++] = q3; }
  }
  return low;
}

/** Whether the box just pushed to `t` sits in a frozen 2x2 block (walls and boxes, a box among them off its goal). */
function frozenBlock(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    if (a < 0 || a + w + 1 >= wall.length) continue;
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/** Walking distance from every square to goal `g` (BFS over floor, walls only), -1 where unreachable. */
function distancesFrom(level: Level, g: number): Int32Array {
  const { w, wall } = level;
  const dist = new Int32Array(wall.length).fill(-1);
  const queue = [g];
  dist[g] = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    const d = dist[p]! + 1;
    const q0 = p - w;
    const q1 = p + w;
    const q2 = p - 1;
    const q3 = p + 1;
    if (wall[q0] === 0 && dist[q0] < 0) { dist[q0] = d; queue.push(q0); }
    if (wall[q1] === 0 && dist[q1] < 0) { dist[q1] = d; queue.push(q1); }
    if (wall[q2] === 0 && dist[q2] < 0) { dist[q2] = d; queue.push(q2); }
    if (wall[q3] === 0 && dist[q3] < 0) { dist[q3] = d; queue.push(q3); }
  }
  return dist;
}

/**
 * Lower bound on the pushes still needed: the cheapest assignment of boxes to
 * goals over walking distances. For up to 5 boxes the assignment is exact
 * (every permutation); beyond that, the sum of each box's nearest goal, which
 * can only undercount the assignment and so stays a lower bound.
 */
function estimate(boxes: number[], goals: number[], dist: Int32Array[]): number {
  const n = boxes.length;
  if (n === 0) return 0;
  if (n <= 5) {
    const cost: number[][] = [];
    for (let i = 0; i < n; i++) {
      cost[i] = [];
      for (let j = 0; j < n; j++) cost[i]![j] = dist[j]![boxes[i]!]!;
    }
    let best = Infinity;
    const perm = [...Array(n).keys()];
    const rec = (k: number): void => {
      if (k === n) {
        let s = 0;
        for (let i = 0; i < n; i++) {
          const c = cost[i]![perm[i]!]!;
          if (c < 0) { s = Infinity; break; }
          s += c;
        }
        if (s < best) best = s;
        return;
      }
      for (let i = k; i < n; i++) {
        [perm[k], perm[i]] = [perm[i]!, perm[k]!];
        rec(k + 1);
        [perm[k], perm[i]] = [perm[i]!, perm[k]!];
      }
    };
    rec(0);
    return best;
  }
  let s = 0;
  for (const b of boxes) {
    let m = Infinity;
    for (let j = 0; j < goals.length; j++) {
      const d = dist[j]![b]!;
      if (d >= 0 && d < m) m = d;
    }
    if (m === Infinity) return Infinity;
    s += m;
  }
  return s;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters (first direction first on ties). */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how: string[] = new Array(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** The square the player stands on after `moves` (LURD, the case aside) from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

/**
 * Push-optimal solution of `level` (or null): A* over pushes when `heuristic`
 * is true, plain push-BFS when false (the same search with a zero estimate).
 * A state is the boxes' squares plus the player's reachable region, named by
 * its lowest square; the first solved state popped is push-optimal.
 */
function searchPush(level: Level, maxStates: number, heuristic: boolean): Solved | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  const dist = heuristic ? goals.map((g) => distancesFrom(level, g)) : [];
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);
  if (level.boxes.some((b) => !live[b])) return null;

  // The states in the order found: boxes, the player's square after the push
  // that made them, the region's lowest square, parent, the push (box square
  // before, after, direction), and how many boxes sit on goals (a tie-break
  // that steers the search toward finished rooms without touching optimality:
  // it only orders states whose f is equal).
  const sBoxes: number[][] = [level.boxes.slice()];
  const sPlayer: number[] = [level.player];
  const sLow: number[] = [];
  const sOn: number[] = [level.boxes.filter((b) => goal[b]).length];
  const sParent: number[] = [-1];
  const sFrom: number[] = [-1];
  const sTo: number[] = [-1];
  const sDir: number[] = [-1];
  const sG: number[] = [0];
  const sH: number[] = [heuristic ? estimate(level.boxes, goals, dist) : 0];
  const keyOf = (boxes: number[], low: number): string => `${boxes.join(',')}|${low}`;
  const best = new Map<string, number>();
  for (const b of level.boxes) occupied[b] = 1;
  const low0 = reach(level, occupied, level.player, seen, ++stamp, stack);
  for (const b of level.boxes) occupied[b] = 0;
  sLow.push(low0);
  best.set(keyOf(level.boxes, low0), 0);

  // Open list: a binary heap on (f, boxes on goals, -g, sequence), so ties
  // break the same way every run.
  type Entry = [number, number, number, number, number]; // f, onGoal, g, sequence, state index
  const heap: Entry[] = [];
  let seq = 0;
  const less = (a: Entry, b: Entry): boolean =>
    a[0] < b[0] ||
    (a[0] === b[0] &&
      (a[1] > b[1] || (a[1] === b[1] && (a[2] > b[2] || (a[2] === b[2] && a[3] < b[3])))));
  const heapPush = (e: Entry): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): Entry => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };
  heapPush([sH[0]!, sOn[0]!, 0, seq++, 0]);

  let found = -1;
  while (heap.length > 0) {
    const [, , g, , s] = heapPop();
    if (best.get(keyOf(sBoxes[s]!, sLow[s]!))! < g) continue;
    const boxes = sBoxes[s]!;
    if (solved(boxes)) {
      found = s;
      break;
    }
    for (const b of boxes) occupied[b] = 1;
    reach(level, occupied, sPlayer[s]!, seen, ++stamp, stack);
    // The squares the player reaches from here, as a stamp on `seen`.
    const here = stamp;
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi]!;
      for (let di = 0; di < 4; di++) {
        const [dx, dy] = DIRS[di]!;
        const d = dy * w + dx;
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(level, occupied, goal, t);
        let key = '';
        let next: number[] | null = null;
        let low = -1;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((a, b2) => a - b2);
          low = reach(level, occupied, b, mark, ++stamp, stack);
          key = keyOf(next, low);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || next === null) continue;
        const ng = g + 1;
        const prevBest = best.get(key);
        if (prevBest !== undefined && prevBest <= ng) continue;
        if (sBoxes.length >= maxStates) return null;
        best.set(key, ng);
        const idx = sBoxes.length;
        sBoxes.push(next);
        sPlayer.push(b);
        sLow.push(low);
        sOn.push(sOn[s]! + (goal[t] ? 1 : 0) - (goal[b] ? 1 : 0));
        sParent.push(s);
        sFrom.push(b);
        sTo.push(t);
        sDir.push(di);
        sG.push(ng);
        const h = heuristic ? estimate(next, goals, dist) : 0;
        sH.push(h);
        heapPush([ng + h, sOn[idx]!, ng, seq++, idx]);
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  if (found < 0) return null;
  // The path of states, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = sParent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes.slice();
  for (const s of path) {
    const from = sFrom[s]!;
    const to = sTo[s]!;
    const di = sDir[s]!;
    const [dx, dy, , pushLetter] = DIRS[di]!;
    const d = dy * w + dx;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += pushLetter;
    player = from;
    boxes = boxes.map((b) => (b === from ? to : b)).sort((a, b2) => a - b2);
  }
  return { pushes: path.length, moves };
}

type Room = { boxes: number[]; goals: number[]; done: boolean };

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway:
 * a box there reaches no goal) out of the floor, and each part left that
 * holds a box is a room. Null when a box starts in the hallway, a goal is
 * cut off, or a part holds more or fewer boxes than goals.
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) if (part[g]! >= 0) rooms[part[g]!]!.goals.push(g);
  if (goals.some((g) => part[g]! < 0) || rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * The level solved room by room: each room's push-optimal solution in turn,
 * the other rooms' boxes standing as walls (on their goals once their room
 * is done), the player walking on from where the last room left it. A box
 * never leaves its room, so the rooms' optima add up to the level's.
 * Falls back to a search over the whole level when the level is no set of rooms.
 */
function solveByRooms(level: Level, maxStates: number): Solved | null {
  const rooms = roomsOf(level);
  if (rooms === null) {
    return searchPush(level, maxStates, true) ?? searchPush(level, maxStates, false);
  }
  let player = level.player;
  let pushes = 0;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = searchPush(sub, maxStates, true) ?? searchPush(sub, maxStates, false);
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return { pushes, moves };
}

for (const id of readdirSync(I).sort()) {
  const level = parseLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  const solved = solveByRooms(level, MAX_STATES);
  const moves = solved ? solved.moves : '';
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
