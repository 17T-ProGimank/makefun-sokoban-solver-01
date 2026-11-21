# Sokoban solver — methodology

## Problem

Each instance is a Sokoban level in XSB (`#` wall, space floor, `.` goal,
`$` box, `*` box on goal, `@` player). The answer is the player's moves
(`u/d/l/r`, upper case marking a push). The checker replays the moves: a
step into a wall, or a push into a wall or another box, scores 0; a replay
ending with every box on a goal scores 1,000 points in P* pushes (the
level's push-optimal count) and `500 × P* / pushes` in more. The set score
is 1,000 × the mean over 5 instances (max 1,000,000). A reward needs a
score strictly above the house baseline, plain-astar 1.0.0.

## Structure of the levels

The generator lays a hallway one square wide across the board, with 1–4
rooms off it (each in a 6×6 slot, one door onto the hallway, no two doors
in one column). A box pushed out of a room's door into the hallway can
never be pushed back, so every box stays in its room: the rooms are
independent problems, joined only by the player's walk, and the level's
optimum P* is the sum of its rooms' optima. The solver exploits this
directly (see `roomsOf` / `solveByRooms` in `main.ts`).

Room detection: cut the dead squares of the player's row (the hallway: a
box there reaches no goal) out of the floor; each connected part left that
holds a box is a room. If a box starts in the hallway, a goal is cut off,
or a part holds more boxes than goals, the level is not a set of rooms and
the solver falls back to a search over the whole level.

## Search

Each room is solved by A* over **pushes** (not single steps):

- **State**: the boxes' squares (sorted) plus the player's reachable
  region, named by its lowest square. The player walks freely inside a
  region, so the exact square does not matter — only the region does.
- **Moves**: from a state, the player walks (BFS) to a square beside a box
  and pushes it one square. The new state has the player on the box's old
  square. Cost is 1 per push.
- **Estimate** (admissible): the Hungarian assignment of boxes to goals
  over walking distances (BFS through floor, ignoring other boxes). Every
  box must be pushed at least its distance to its assigned goal, and each
  push moves exactly one box one square, so the cheapest assignment is a
  lower bound on the pushes still needed. For up to 5 boxes the assignment
  is exact (every permutation); beyond that, the sum of each box's nearest
  goal, which can only undercount the assignment.
- **Deadlock pruning** (both sound — neither prunes a solvable state):
  - *Live squares*: reverse BFS from the goals in the push graph. A
    square is live when a box on it can be pushed onto some goal
    (ignoring other boxes). A box on a dead square ends the state.
    This covers corners, wall runs with no goal, and enclosed areas.
  - *Frozen 2×2*: a 2×2 block of walls and boxes holding a box off its
    goal can never be broken, so the state is dead.
- **Tie-breaking**: the heap orders by (f, boxes on goals, -g, insertion
  sequence). Preferring more boxes on goals among equal f finds the
  optimum with fewer expansions; it cannot change optimality, since any
  solution through a state costs at least that state's f.
- **Budget**: counted in states (500,000 per room search), never the
  clock, so two runs agree byte for byte. When A* gives up on a room, a
  plain push-BFS (the same search with a zero estimate) gets a second
  chance before the room is left unsolved.

Because the estimate is admissible and the deadlocks are sound, the first
solved state popped is push-optimal for its room, and the rooms' optima
add up to the level's P*.

## Worked example (practice i001, P* = 13)

Level (8×10, 3 boxes, 1 room):

```
########
#     ##
#..   ##
#  $ ###
#    ###
###$.###
###   ##
####$###
#     @#
########
```

The hallway is row 8; the room is rows 1–7, its door at (4,7) — which
initially holds a box. The player walks from (6,8) to (4,8) and pushes
that box up into the room as the first push. The solver's answer (46
moves, 13 pushes) replays to all three boxes on goals:

```
llUUUUlUluurrdLLddrrUluurrdLLddrddlUruulldRurD
```

(Upper-case letters are the 13 pushes, verified by replay.) The checker
confirms: "solved in 13 pushes (P* 13)", 1,000 points.

## Verified results

Practice set (kit's `practice/`, P* 13/16/29/47/60):

| instance | boxes | rooms | pushes | P* | points |
|----------|-------|-------|--------|----|--------|
| i001 | 3 | 1 | 13 | 13 | 1,000 |
| i002 | 4 | 1 | 16 | 16 | 1,000 |
| i003 | 8 | 2 | 29 | 29 | 1,000 |
| i004 | 12 | 3 | 47 | 47 | 1,000 |
| i005 | 16 | 4 | 60 | 60 | 1,000 |

**Score: 1,000,000** (whole set in under 1 second; two runs byte-identical).

House baseline plain-astar 1.0.0 on the same set: **200,000** — it solves
only i001 (13 pushes) and gives up on i002–i005 (empty answers) after
burning its 200,000-expansion budget on each, taking ~15.6 s. It searches
over single moves (not pushes), minimises moves instead of pushes, and
knows no deadlock, so it spends its budget on positions no push can save.

Three further sets drawn fresh from the kit's own generator
(`program/generator/draw.ts`, random seeds), scored with the kit's scorer:

| set | solver | baseline |
|-----|--------|----------|
| 1 | 1,000,000 (0.63 s) | 400,000 (11.9 s) |
| 2 | 1,000,000 (0.73 s) | 400,000 (12.1 s) |
| 3 | 1,000,000 (0.90 s) | 173,214 (11.7 s) |

The solver is push-optimal on every set tested (4/4 perfect scores) and
roughly 15× faster than the baseline, with far more headroom under the
60-second wall budget.

## Limitations

- The room decomposition assumes the generator's layout (hallway + rooms
  with one door each). A level that is not a set of rooms falls back to a
  whole-level push search, which is far slower for many boxes — but every
  level this generator draws is a set of rooms.
- The Hungarian estimate is exact only up to 5 boxes per room; rooms hold
  at most 4, so this never binds.
- The search budget is per room (500,000 states). Rooms are kept by the
  generator only when the reference push-BFS solves them within 250,000
  states, and A* with an admissible estimate explores a subset of a BFS's
  states, so the budget has wide margin.
