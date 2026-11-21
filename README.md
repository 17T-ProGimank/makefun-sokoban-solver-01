# sokoban-solver-01 — a push-optimal Sokoban solver

[![make.fun bounty](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/17T-ProGimank/makefun-sokoban-solver-01/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/17T-ProGimank/makefun-sokoban-solver-01/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver for [make.fun](https://make.fun)'s sokoban-solver-01-run-20261121: one program answers all 5 instances of a set in as few pushes as possible.

- Bounty: https://make.fun/bounty/sokoban-solver-01-run-20261121
- Referral: https://make.fun/r/m4psg5rh

## How it works

`main.ts` (Node 22, no dependencies) reads `/input/<id>/level.txt` for each
instance and writes `/output/<id>/solution.txt` with the player's moves
(u/d/l/r, upper case marking a push).

A level is a hallway with 1–4 rooms off it, and a box pushed out of a room's
door into the hallway is lost, so every room is an independent problem and
the level's push-optimal count is the sum of its rooms' optima. The solver
therefore splits the level into rooms, solves each room push-optimally, and
stitches the moves together (the player walks the hallway between rooms).

Each room is solved by A* over pushes (not single steps): a state is the
boxes' squares plus the player's reachable region (named by its lowest
square). The estimate is the Hungarian assignment of boxes to goals over
walking distances (admissible: every box must be pushed at least its
distance to its goal), and two deadlocks are pruned: a box on a square from
which no push sequence reaches a goal (live-squares analysis), and a frozen
2×2 block of walls and boxes holding a box off its goal. The search budget
is counted in states, never the clock, so two runs agree byte for byte. When
A* gives up on a room, a plain push-BFS (the same search with a zero
estimate) gets a second chance before the room is left unsolved.

## Results

On the kit's practice set the solver scores **1,000,000** — every instance
solved in exactly its push-optimal count (13, 16, 29, 47, 60 pushes) — in
under a second for the whole set. The house baseline (plain-astar 1.0.0)
scores 200,000 on the same set: it solves only the first instance and gives
up on the rest. On three further sets drawn fresh from the kit's own
generator the solver again scores 1,000,000 each (baseline: 400,000,
400,000, 173,214).

## Layout

- `main.ts` — the whole solver (entrypoint, Node 22)
- `README.md` — this file
- `LICENSE` — MIT
- `.makefun/owner.json` — the payout wallet

## Run it

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```
