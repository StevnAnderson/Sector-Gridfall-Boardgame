/**
 * Play-mode state for the starter map.
 *
 * The board is a large hexagon three hexes along each side: nineteen hexes in a
 * pointy-top odd-r grid. The middle hex of each side carries both a mineral and a
 * gas node. Player A starts on the top edge and Player B on the bottom edge. Both
 * players plan at the same time: any number of pieces from one hex may march
 * together to one adjacent hex, then both plans resolve together. Allied armies
 * merge, enemy-held hexes become conflicts, and conflicts are fought out before
 * the next round begins.
 *
 * Workers harvest at the end of the round. A Base on a mineral node turns up to
 * three assigned Workers into minerals at 1 each; a Refinery on a gas node does
 * the same for gas. A hex holding both structures makes the Worker pick one; the
 * choice is remembered until it moves again. Structures off a node produce
 * nothing, and extra Workers beyond the cap add nothing.
 *
 * This is deliberately framework-free so the movement/harvest rules can be
 * tested without React.
 */

import { resolveBattle, type BattleResult, type SurvivingCard } from "./battle";
import { CARD_BY_ID, CARD_DEFINITIONS, getDefinition } from "./codex";
import type { Card, Cost } from "./types";

export type Player = "a" | "b";
export type ResourceType = "minerals" | "gas";
export type PlayStructureType = "base" | "refinery" | "barracks" | "factory";
export type PlayUnitType = PlayStructureType | "worker" | "soldier";

/** The two structures a Worker can harvest from. */
export type GatherFrom = "base" | "refinery";

/** Planning is the normal round. Battle pauses the round while conflicts resolve. */
export type PlayPhase = "planning" | "battle";

export interface HexCoord {
  col: number;
  row: number;
}

export interface MapTile extends HexCoord {
  id: string;
  /** Nodes on this hex. A side-centre hex carries both mineral and gas nodes. */
  resources: ResourceType[];
}

export interface PlayUnit extends HexCoord {
  id: string;
  owner: Player;
  typeId: PlayUnitType;
  /** Current HP after any battles; defaults to the codex value when absent. */
  hp?: number;
  /** A unit may make one move per round. */
  moved: boolean;
  /**
   * Workers only. Which structure they were told to gather from when their hex
   * holds both a Base and a Refinery. Absent means "not chosen" — the Worker
   * falls back to the Base. Cleared when the Worker leaves a dual hex.
   */
  gatherFrom?: GatherFrom;
}

/** One unit's planned step for the coming round. */
export interface PlayMove {
  unitId: string;
  col: number;
  row: number;
}

/**
 * A piece constructs or trains something on its own hex. Workers build
 * structures; Bases train Workers. The builder spends its action for the round,
 * so it cannot move as well.
 */
export interface BuildOrder {
  builderId: string;
  typeId: PlayUnitType;
}

/** One player's orders for a round. */
export interface PlayerSubmission {
  moves: PlayMove[];
  builds: BuildOrder[];
  /** Re-pick or confirm which structure a Worker gathers from. */
  harvests?: HarvestChoice[];
}

/** Set a Worker's chosen structure for a hex holding both a Base and a Refinery. */
export interface HarvestChoice {
  unitId: string;
  gatherFrom: GatherFrom;
}

/** Older callers submit a bare move list; both shapes are accepted. */
export type SubmissionInput = PlayerSubmission | PlayMove[];

/** Both players' plans for a round. The host pairs these up before resolving. */
export interface RoundSubmissions {
  a: SubmissionInput;
  b: SubmissionInput;
}

export function normalizeSubmission(input: SubmissionInput): PlayerSubmission {
  return Array.isArray(input)
    ? { moves: input, builds: [], harvests: [] }
    : { moves: input.moves, builds: input.builds ?? [], harvests: input.harvests ?? [] };
}

/** Everything a player can build from one selected piece. */
export interface BuildOption {
  typeId: PlayUnitType;
  name: string;
  kind: "unit" | "structure";
  cost: Cost;
  glyph: string;
  supplyUsed: number;
  supplyMax: number;
  enabled: boolean;
  /** Why the option is unavailable, or null when it can be built. */
  reason: string | null;
}

export interface BuildCheck {
  ok: boolean;
  reason: string | null;
}

export interface Stock {
  minerals: number;
  gas: number;
}

/** One allied group marching at a contested hex, grouped by its origin hex. */
export interface ConflictAttack {
  player: Player;
  from: HexCoord;
  unitIds: string[];
}

/**
 * A hex that two players both want at the same time. The attackers stay in their
 * origin hexes until the battle is resolved; the defender holds the target.
 */
export interface Conflict {
  id: string;
  target: HexCoord;
  /** The side treated as the defender. For a clash over an empty hex this is arbitrary. */
  defender: Player;
  attacks: ConflictAttack[];
}

export interface BattleUnitSummary {
  unitId: string;
  typeId: PlayUnitType;
  hp: number;
}

/** A resolved conflict, kept so the UI can show what happened. */
export interface BattleReport {
  conflictId: string;
  target: HexCoord;
  defender: Player;
  attacker: Player;
  winner: Player | "draw";
  reason: string;
  loops: number;
  startingUnits: Record<Player, number>;
  survivors: Record<Player, BattleUnitSummary[]>;
  rounds: BattleResult["rounds"];
  /** True when the attacking survivors took the contested hex. */
  occupied: boolean;
}

export interface PlayState {
  units: PlayUnit[];
  active: Player;
  turn: number;
  stock: Record<Player, Stock>;
  log: string[];
  /** Set when a player forfeits the online match. */
  winner: Player | null;
  phase: PlayPhase;
  /** Populated while `phase` is "battle"; the borders that should glow. */
  conflicts: Conflict[];
  /** Results of the most recent battle phase. */
  battles: BattleReport[];
}

/** Everything a player can send during an online match. */
export type PlayAction =
  | {
      type: "submit";
      moves: PlayMove[];
      builds: BuildOrder[];
      harvests?: HarvestChoice[];
    }
  | { type: "forfeit" };

/**
 * Bounding box of the hexagon. Not every coordinate in the box is on the board:
 * the six gaps at (0,0), (4,0), (4,1), (4,3), (0,4) and (4,4) are cut off,
 * leaving a nineteen-hex large hex three hexes along each side.
 */
export const MAP_COLS = 5;
export const MAP_ROWS = 5;

/** One structure can turn at most this many assigned Workers into resources. */
export const HARVEST_CAP = 3;

/** A small opening stock so the first construction phase has something to spend. */
export const STARTING_STOCK: Stock = { minerals: 4, gas: 0 };

export const PLAYER_LABEL: Record<Player, string> = {
  a: "Player A",
  b: "Player B",
};

export const UNIT_LABEL: Record<PlayUnitType, string> = {
  base: "Base",
  refinery: "Refinery",
  barracks: "Barracks",
  factory: "Factory",
  worker: "Worker",
  soldier: "Soldier",
};

export function hexId(col: number, row: number): string {
  return `${col},${row}`;
}

export function tileLabel(col: number, row: number): string {
  return `${"ABCDE"[col] ?? "?"}${row + 1}`;
}

/** Cube distance from the centre of the board, expressed in odd-r offset. */
function hexDistanceFromCentre(col: number, row: number): number {
  const q = col - Math.floor(row / 2);
  const r = row;
  const dq = q - 1;
  const dr = r - 2;
  return Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr));
}

/** The middle hex of each of the six sides of the large hex. */
const RESOURCE_NODES: HexCoord[] = [
  { col: 2, row: 0 },
  { col: 3, row: 1 },
  { col: 3, row: 3 },
  { col: 2, row: 4 },
  { col: 0, row: 3 },
  { col: 0, row: 1 },
];

export const MAP_TILES: MapTile[] = Array.from({ length: MAP_ROWS }, (_, row) =>
  Array.from({ length: MAP_COLS }, (_, col) => ({ col, row })),
)
  .flat()
  .filter(({ col, row }) => hexDistanceFromCentre(col, row) <= 2)
  .map(({ col, row }) => ({
    id: hexId(col, row),
    col,
    row,
    resources: RESOURCE_NODES.some(
      (node) => node.col === col && node.row === row,
    )
      ? (["minerals", "gas"] as ResourceType[])
      : [],
  }));

const MAP_TILE_IDS = new Set(MAP_TILES.map((tile) => tile.id));

export function inBounds(col: number, row: number): boolean {
  return MAP_TILE_IDS.has(hexId(col, row));
}

export function tileAt(col: number, row: number): MapTile | undefined {
  if (!inBounds(col, row)) return undefined;
  return MAP_TILES.find((tile) => tile.col === col && tile.row === row);
}

/**
 * Pointy-top hexes use staggered (odd-r) rows: odd rows sit half a hex to the
 * right. Each row therefore has a different pair of upper/lower neighbours.
 */
export function neighbors(col: number, row: number): HexCoord[] {
  const deltas: Array<[number, number]> =
    row % 2 === 0
      ? [
          [-1, 0],
          [1, 0],
          [-1, -1],
          [0, -1],
          [-1, 1],
          [0, 1],
        ]
      : [
          [-1, 0],
          [1, 0],
          [0, -1],
          [1, -1],
          [0, 1],
          [1, 1],
        ];
  return deltas
    .map(([dc, dr]) => ({ col: col + dc, row: row + dr }))
    .filter((coord) => inBounds(coord.col, coord.row));
}

/** Every piece on a hex. A hex may hold any number of pieces from one side. */
export function unitsAt(state: PlayState, col: number, row: number): PlayUnit[] {
  return state.units.filter((unit) => unit.col === col && unit.row === row);
}

/** The first piece on a hex; use unitsAt when the hex may hold a stack. */
export function unitAt(state: PlayState, col: number, row: number): PlayUnit | undefined {
  return unitsAt(state, col, row)[0];
}

export function unitById(state: PlayState, id: string): PlayUnit | undefined {
  return state.units.find((unit) => unit.id === id);
}

/** Current HP, falling back to the codex value for older saved states. */
export function unitHp(unit: PlayUnit): number {
  return Math.max(0, unit.hp ?? getDefinition(unit.typeId).hp);
}

/** Producing Base and Refinery counts on one hex for the given player. */
function producingStructuresAt(
  state: PlayState,
  player: Player,
  col: number,
  row: number,
): Record<GatherFrom, number> {
  const counts: Record<GatherFrom, number> = { base: 0, refinery: 0 };
  const nodes = tileAt(col, row)?.resources ?? [];
  for (const unit of state.units) {
    if (unit.owner !== player || unit.col !== col || unit.row !== row) continue;
    if (unit.typeId === "base" && nodes.includes("minerals")) counts.base += 1;
    if (unit.typeId === "refinery" && nodes.includes("gas")) counts.refinery += 1;
  }
  return counts;
}

/**
 * Structures a Worker could gather from on a hex. Only the player's own Base
 * on a mineral node and Refinery on a gas node produce income; structures off
 * a node, other structures and enemy buildings do not.
 */
export function gatherOptionsAt(
  state: PlayState,
  player: Player,
  col: number,
  row: number,
): GatherFrom[] {
  const counts = producingStructuresAt(state, player, col, row);
  return (["base", "refinery"] as GatherFrom[]).filter(
    (kind) => counts[kind] > 0,
  );
}

/** Where one Worker will gather, or null when its hex has no producing structure. */
export function gatherFor(
  state: PlayState,
  unit: PlayUnit,
): { from: GatherFrom; resource: ResourceType } | null {
  if (unit.typeId !== "worker") return null;
  const options = gatherOptionsAt(state, unit.owner, unit.col, unit.row);
  if (options.length === 0) return null;
  const from: GatherFrom =
    options.length === 1 ? options[0]! : unit.gatherFrom ?? "base";
  return { from, resource: from === "base" ? "minerals" : "gas" };
}

/**
 * The Worker's remembered choice once it stands on `col,row`. A single producing
 * structure needs no choice; a dual hex keeps `chosen`, or the old choice when
 * the Worker stayed put, and falls back to the Base.
 */
function gatherForPosition(
  state: PlayState,
  unit: PlayUnit,
  col: number,
  row: number,
  chosen?: GatherFrom,
  preserve = true,
): GatherFrom | undefined {
  const options = gatherOptionsAt(state, unit.owner, col, row);
  if (options.length === 0) return undefined;
  if (options.length === 1) return options[0];
  return chosen ?? (preserve ? unit.gatherFrom : undefined) ?? "base";
}

/** True when the hex holds at least one piece from the other side. */
export function isEnemyOccupied(
  state: PlayState,
  player: Player,
  col: number,
  row: number,
): boolean {
  return unitsAt(state, col, row).some((unit) => unit.owner !== player);
}

/** Fill in the extra fields added after the first saved games. */
export function normalizePlayState(state: PlayState): PlayState {
  return {
    ...state,
    phase: state.phase ?? "planning",
    conflicts: state.conflicts ?? [],
    battles: state.battles ?? [],
  };
}

/** Structures never move once they are on the map. */
export function isStructureType(typeId: string): boolean {
  return CARD_BY_ID[typeId]?.kind === "structure";
}

/** Short "3◆ 1▲" cost string for the build window. */
export function describeCost(cost: Cost): string {
  const parts: string[] = [];
  if (cost.minerals > 0) parts.push(`${cost.minerals}◆`);
  if (cost.gas > 0) parts.push(`${cost.gas}▲`);
  return parts.length > 0 ? parts.join(" ") : "free";
}

/** Units a structure can train on its own hex. */
const TRAINED_BY: Partial<Record<PlayUnitType, PlayUnitType>> = {
  base: "worker",
  barracks: "soldier",
};

const TRAIN_REASON: Partial<Record<PlayUnitType, string>> = {
  base: "Bases train Workers",
  barracks: "Barracks train Soldiers",
};

/**
 * Why a particular piece can or cannot build a particular card. Workers build
 * structures; Bases train Workers and Barracks train Soldiers. Unlocks are per
 * player: owning a Base anywhere lets any Worker build a Refinery or Barracks,
 * and owning a Barracks unlocks the Factory.
 */
export function canBuild(
  state: PlayState,
  player: Player,
  builderId: string,
  typeId: string,
): BuildCheck {
  const builder = unitById(state, builderId);
  if (!builder || builder.owner !== player) {
    return { ok: false, reason: "Not your piece" };
  }

  const def = CARD_BY_ID[typeId];
  if (!def) return { ok: false, reason: "Unknown build" };

  if (state.winner || state.phase !== "planning") {
    return { ok: false, reason: "Battle phase" };
  }
  if (builder.moved) {
    return { ok: false, reason: "Already acted this round" };
  }

  const trained = TRAINED_BY[builder.typeId];
  if (builder.typeId === "worker") {
    if (def.kind !== "structure") {
      return { ok: false, reason: "Workers build structures" };
    }
  } else if (trained !== undefined) {
    if (def.id !== trained) {
      return { ok: false, reason: TRAIN_REASON[builder.typeId] ?? "Cannot train" };
    }
  } else {
    return { ok: false, reason: "This piece cannot build" };
  }

  if (def.kind === "structure" && def.id !== "base") {
    const owned = new Set<string>(
      state.units.filter((unit) => unit.owner === player).map((unit) => unit.typeId),
    );
    const unlocker = CARD_DEFINITIONS.find((entry) =>
      entry.unlocks?.includes(def.id),
    );
    if (unlocker && !owned.has(unlocker.id)) {
      return { ok: false, reason: `Requires ${unlocker.name}` };
    }
  }

  const used = state.units.filter(
    (unit) => unit.owner === player && unit.typeId === def.id,
  ).length;
  if (used >= def.supply) {
    return { ok: false, reason: `Supply limit ${def.supply}` };
  }

  const stock = state.stock[player];
  if (stock.minerals < def.cost.minerals || stock.gas < def.cost.gas) {
    return { ok: false, reason: `Needs ${describeCost(def.cost)}` };
  }

  return { ok: true, reason: null };
}

/** The build window's contents for one selected piece. */
export function buildOptions(
  state: PlayState,
  player: Player,
  builderId: string,
): BuildOption[] {
  const builder = unitById(state, builderId);
  if (!builder || builder.owner !== player) return [];

  const trained = TRAINED_BY[builder.typeId];
  const defs =
    builder.typeId === "worker"
      ? CARD_DEFINITIONS.filter((def) => def.kind === "structure")
      : trained !== undefined
        ? CARD_DEFINITIONS.filter((def) => def.id === trained)
        : [];
  if (defs.length === 0) return [];

  return defs.map((def) => {
    const check = canBuild(state, player, builderId, def.id);
    const used = state.units.filter(
      (unit) => unit.owner === player && unit.typeId === def.id,
    ).length;
    return {
      typeId: def.id as PlayUnitType,
      name: def.name,
      kind: def.kind,
      cost: def.cost,
      glyph: def.glyph,
      supplyUsed: used,
      supplyMax: def.supply,
      enabled: check.ok,
      reason: check.reason,
    };
  });
}

function spawnUnit(
  units: PlayUnit[],
  player: Player,
  typeId: PlayUnitType,
  col: number,
  row: number,
): PlayUnit {
  const prefix = `${player}-${typeId}`;
  let index = 1;
  while (units.some((unit) => unit.id === `${prefix}-${index}`)) index += 1;
  return {
    id: `${prefix}-${index}`,
    owner: player,
    typeId,
    col,
    row,
    moved: true,
  };
}

interface AppliedBuilds {
  state: PlayState;
  messages: string[];
}

/**
 * Apply one player's build orders in order. Invalid orders are ignored (like
 * forged moves), and each piece can only build once. Costs are paid from the
 * stock the player had at the start of the round.
 */
function applyBuildOrders(
  state: PlayState,
  player: Player,
  orders: BuildOrder[],
): AppliedBuilds {
  let working = state;
  const messages: string[] = [];
  const claimed = new Set<string>();

  for (const order of orders) {
    if (
      !order ||
      typeof order.builderId !== "string" ||
      typeof order.typeId !== "string" ||
      claimed.has(order.builderId)
    ) {
      continue;
    }

    const check = canBuild(working, player, order.builderId, order.typeId);
    if (!check.ok) continue;

    const builder = unitById(working, order.builderId);
    const def = CARD_BY_ID[order.typeId];
    if (!builder || !def) continue;

    const spawned = spawnUnit(
      working.units,
      player,
      order.typeId,
      builder.col,
      builder.row,
    );
    claimed.add(order.builderId);
    working = {
      ...working,
      units: [
        ...working.units.map((unit) =>
          unit.id === builder.id ? { ...unit, moved: true } : unit,
        ),
        spawned,
      ],
      stock: {
        ...working.stock,
        [player]: {
          minerals: working.stock[player].minerals - def.cost.minerals,
          gas: working.stock[player].gas - def.cost.gas,
        },
      },
    };
    messages.push(
      `${PLAYER_LABEL[player]} ${def.kind === "unit" ? "trained" : "built"} ${def.name} at ${tileLabel(builder.col, builder.row)}.`,
    );
  }

  return { state: working, messages };
}

/** Practice-mode build: apply one order immediately on the active player's turn. */
export function buildUnit(
  state: PlayState,
  player: Player,
  builderId: string,
  typeId: PlayUnitType,
): PlayState {
  if (state.winner || state.phase !== "planning" || player !== state.active) {
    return state;
  }
  if (!canBuild(state, player, builderId, typeId).ok) return state;

  const { state: next, messages } = applyBuildOrders(state, player, [
    { builderId, typeId },
  ]);
  if (next === state) return state;
  return { ...next, log: [...state.log, ...messages].slice(-10) };
}

/**
 * Re-pick which structure a Worker gathers from on a dual hex. This is not an
 * action: it does not spend the Worker's move. Only meaningful when the Worker's
 * own hex holds both a Base and a Refinery.
 */
export function setGatherPreference(
  state: PlayState,
  player: Player,
  unitId: string,
  gatherFrom: GatherFrom,
): PlayState {
  if (state.winner || state.phase !== "planning") return state;
  const unit = unitById(state, unitId);
  if (!unit || unit.owner !== player || unit.typeId !== "worker") return state;
  if (gatherOptionsAt(state, player, unit.col, unit.row).length < 2) return state;
  if (unit.gatherFrom === gatherFrom) return state;

  return {
    ...state,
    units: state.units.map((entry) =>
      entry.id === unit.id ? { ...entry, gatherFrom } : entry,
    ),
  };
}

export function createInitialState(): PlayState {
  return {
    units: [
      { id: "a-base", owner: "a", typeId: "base", col: 2, row: 0, moved: false },
      { id: "a-worker", owner: "a", typeId: "worker", col: 1, row: 0, moved: false },
      { id: "a-soldier", owner: "a", typeId: "soldier", col: 3, row: 0, moved: false },
      { id: "b-base", owner: "b", typeId: "base", col: 2, row: 4, moved: false },
      { id: "b-worker", owner: "b", typeId: "worker", col: 1, row: 4, moved: false },
      { id: "b-soldier", owner: "b", typeId: "soldier", col: 3, row: 4, moved: false },
    ],
    active: "a",
    turn: 1,
    stock: {
      a: { ...STARTING_STOCK },
      b: { ...STARTING_STOCK },
    },
    log: ["Click one of your hexes to inspect the pieces there."],
    winner: null,
    phase: "planning",
    conflicts: [],
    battles: [],
  };
}

export function otherPlayer(player: Player): Player {
  return player === "a" ? "b" : "a";
}

export function isAdjacent(from: HexCoord, to: HexCoord): boolean {
  return neighbors(from.col, from.row).some(
    (coord) => coord.col === to.col && coord.row === to.row,
  );
}

/**
 * A move is legal if the piece is mobile and the hex is adjacent. Occupancy is
 * no longer a blocker: allied hexes merge and enemy hexes become conflicts.
 */
export function canUnitMoveTo(
  state: PlayState,
  unit: PlayUnit,
  col: number,
  row: number,
): boolean {
  void state;
  if (unit.moved || isStructureType(unit.typeId)) return false;
  if (!inBounds(col, row)) return false;
  return isAdjacent(unit, { col, row });
}

export function canMoveTo(state: PlayState, unit: PlayUnit, col: number, row: number): boolean {
  if (unit.owner !== state.active) return false;
  return canUnitMoveTo(state, unit, col, row);
}

/**
 * Move one piece to an adjacent hex without starting a battle. Enemy-held hexes
 * are an attack, so this helper refuses them; practice uses moveUnits instead.
 */
export function moveUnit(
  state: PlayState,
  unitId: string,
  col: number,
  row: number,
  gatherFrom?: GatherFrom,
): PlayState {
  const unit = unitById(state, unitId);
  if (!unit || !canMoveTo(state, unit, col, row)) return state;
  if (isEnemyOccupied(state, unit.owner, col, row)) return state;

  const message = `${PLAYER_LABEL[unit.owner]} moved ${UNIT_LABEL[unit.typeId]} to ${tileLabel(col, row)}.`;
  return {
    ...state,
    units: state.units.map((entry) => {
      if (entry.id !== unitId) return entry;
      const moved: PlayUnit = { ...entry, col, row, moved: true };
      if (entry.typeId === "worker") {
        moved.gatherFrom = gatherForPosition(state, entry, col, row, gatherFrom, false);
      }
      return moved;
    }),
    phase: "planning",
    conflicts: [],
    log: [...state.log, message].slice(-10),
  };
}

/**
 * Hotseat helper: march every listed piece to the same hex. Allied armies merge
 * freely; if an enemy holds the hex, the battle is fought immediately.
 */
export function moveUnits(
  state: PlayState,
  unitIds: string[],
  col: number,
  row: number,
  gatherFrom?: GatherFrom,
): PlayState {
  if (state.winner || state.phase !== "planning") return state;

  const chosen: PlayUnit[] = [];
  for (const id of new Set(unitIds)) {
    const unit = unitById(state, id);
    if (!unit) continue;
    if (!canMoveTo(state, unit, col, row)) continue;
    chosen.push(unit);
  }
  const first = chosen[0];
  if (!first) return state;

  const player = first.owner;
  const defenders = unitsAt(state, col, row).filter((unit) => unit.owner !== player);

  const leadDefender = defenders[0];
  if (leadDefender) {
    const attacks = groupAttacks(chosen);
    const conflict: Conflict = {
      id: `conflict-${hexId(col, row)}-${state.turn}`,
      target: { col, row },
      defender: leadDefender.owner,
      attacks,
    };
    const outcome = applyConflict(state.units, conflict);
    return {
      ...state,
      units: outcome.units,
      battles: [outcome.report, ...state.battles].slice(0, 3),
      log: [...state.log, ...outcome.log].slice(-10),
    };
  }

  const names = describeUnits(chosen);
  return {
    ...state,
    units: state.units.map((unit) => {
      if (!chosen.some((entry) => entry.id === unit.id)) return unit;
      const moved: PlayUnit = { ...unit, col, row, moved: true };
      if (unit.typeId === "worker") {
        moved.gatherFrom = gatherForPosition(state, unit, col, row, gatherFrom, false);
      }
      return moved;
    }),
    phase: "planning",
    conflicts: [],
    log: [
      ...state.log,
      `${PLAYER_LABEL[player]} moved ${names} to ${tileLabel(col, row)}.`,
    ].slice(-10),
  };
}

/**
 * Resources the given player's Workers would collect if the turn ended now.
 * Each Base/Refinery on a matching node turns at most HARVEST_CAP assigned
 * Workers into resources; extra Workers on the same structure add nothing.
 */
export function harvestFor(state: PlayState, player: Player): Stock {
  const gained: Stock = { minerals: 0, gas: 0 };
  const assigned = new Map<string, Record<GatherFrom, number>>();

  for (const unit of state.units) {
    if (unit.owner !== player || unit.typeId !== "worker") continue;
    const gather = gatherFor(state, unit);
    if (!gather) continue;
    const key = hexId(unit.col, unit.row);
    const counts = assigned.get(key) ?? { base: 0, refinery: 0 };
    counts[gather.from] += 1;
    assigned.set(key, counts);
  }

  for (const [key, counts] of assigned) {
    const [col, row] = key.split(",").map(Number);
    if (col === undefined || row === undefined) continue;
    const sites = producingStructuresAt(state, player, col, row);
    gained.minerals += Math.min(counts.base, sites.base * HARVEST_CAP);
    gained.gas += Math.min(counts.refinery, sites.refinery * HARVEST_CAP);
  }

  return gained;
}

function describeHarvest(gained: Stock): string {
  const parts: string[] = [];
  if (gained.minerals > 0) {
    parts.push(`${gained.minerals} mineral${gained.minerals === 1 ? "" : "s"}`);
  }
  if (gained.gas > 0) {
    parts.push(`${gained.gas} gas`);
  }
  return parts.length > 0 ? `collected ${parts.join(" and ")}` : "collected nothing";
}

/**
 * Harvest for the active player, reset the incoming player's movement, and pass
 * the turn. Turn numbers count completed rounds (Player B ending their turn).
 */
export function endTurn(state: PlayState): PlayState {
  const gained = harvestFor(state, state.active);
  const next: Player = state.active === "a" ? "b" : "a";
  const message = `${PLAYER_LABEL[state.active]} ${describeHarvest(gained)}. ${PLAYER_LABEL[next]}'s turn.`;

  return {
    ...state,
    units: state.units.map((unit) =>
      unit.owner === next ? { ...unit, moved: false } : unit,
    ),
    stock: {
      ...state.stock,
      [state.active]: {
        minerals: state.stock[state.active].minerals + gained.minerals,
        gas: state.stock[state.active].gas + gained.gas,
      },
    },
    active: next,
    turn: next === "a" ? state.turn + 1 : state.turn,
    phase: "planning",
    conflicts: [],
    log: [...state.log, message].slice(-10),
  };
}

interface AcceptedMove {
  player: Player;
  unit: PlayUnit;
  move: PlayMove;
}

function acceptedMoves(
  state: PlayState,
  player: Player,
  moves: PlayMove[],
): AcceptedMove[] {
  const accepted: AcceptedMove[] = [];
  const claimedUnits = new Set<string>();

  for (const move of moves) {
    const unit = unitById(state, move.unitId);
    if (!unit || unit.owner !== player) continue;
    if (claimedUnits.has(unit.id)) continue;
    if (!canUnitMoveTo(state, unit, move.col, move.row)) continue;

    claimedUnits.add(unit.id);
    accepted.push({ player, unit, move });
  }

  return accepted;
}

function describeUnits(units: PlayUnit[]): string {
  if (units.length === 0) return "no pieces";
  const counts = new Map<PlayUnitType, number>();
  for (const unit of units) {
    counts.set(unit.typeId, (counts.get(unit.typeId) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([typeId, count]) => `${count} ${UNIT_LABEL[typeId]}${count === 1 ? "" : "s"}`)
    .join(" + ");
}

function groupAttacks(units: PlayUnit[]): ConflictAttack[] {
  const groups = new Map<string, ConflictAttack>();
  for (const unit of units) {
    const key = hexId(unit.col, unit.row);
    const attack = groups.get(key) ?? {
      player: unit.owner,
      from: { col: unit.col, row: unit.row },
      unitIds: [],
    };
    attack.unitIds.push(unit.id);
    groups.set(key, attack);
  }
  return [...groups.values()];
}

interface PlannedRound {
  /** The board after construction and uncontested movement. */
  state: PlayState;
  conflicts: Conflict[];
  log: string[];
}

/**
 * Apply every uncontested move, then hold attacking armies in place at any hex
 * that would end up with both players' pieces. The final positions are the start
 * of the battle phase.
 */
function planRound(state: PlayState, submissions: RoundSubmissions): PlannedRound {
  const aSubmission = normalizeSubmission(submissions.a);
  const bSubmission = normalizeSubmission(submissions.b);

  // Construction happens before armies move. Build orders spend the builder's
  // action, so a Worker that builds cannot also march this round.
  const builtA = applyBuildOrders(state, "a", aSubmission.builds);
  const builtB = applyBuildOrders(builtA.state, "b", bSubmission.builds);
  const working = builtB.state;
  const buildLog = [...builtA.messages, ...builtB.messages];

  const accepted = [
    ...acceptedMoves(working, "a", aSubmission.moves),
    ...acceptedMoves(working, "b", bSubmission.moves),
  ];
  const movesByUnit = new Map(accepted.map((entry) => [entry.unit.id, entry]));

  const positions = new Map<string, HexCoord>();
  for (const unit of working.units) {
    positions.set(unit.id, { col: unit.col, row: unit.row });
  }
  for (const entry of accepted) {
    positions.set(entry.unit.id, { col: entry.move.col, row: entry.move.row });
  }

  // Harvest choices arrive with the moves. A choice is only meaningful when the
  // Worker's current hex or its destination holds both a Base and a Refinery.
  const harvestChoices = new Map<string, GatherFrom>();
  for (const player of ["a", "b"] as Player[]) {
    const submission = player === "a" ? aSubmission : bSubmission;
    for (const choice of submission.harvests ?? []) {
      if (
        !choice ||
        (choice.gatherFrom !== "base" && choice.gatherFrom !== "refinery")
      ) {
        continue;
      }
      const unit = unitById(working, choice.unitId);
      if (!unit || unit.owner !== player || unit.typeId !== "worker") continue;

      const destination = positions.get(unit.id) ?? { col: unit.col, row: unit.row };
      const current = gatherOptionsAt(working, player, unit.col, unit.row);
      const arriving = gatherOptionsAt(
        working,
        player,
        destination.col,
        destination.row,
      );
      if (current.length > 1 || arriving.length > 1) {
        harvestChoices.set(unit.id, choice.gatherFrom);
      }
    }
  }

  const held = new Set<string>();
  const conflictsByHex = new Map<
    string,
    { target: HexCoord; defender: Player; attacks: Map<string, ConflictAttack> }
  >();

  // Holding an attacker can create a new clash at its origin, so repeat until
  // every clash has been found. Each piece can be held at most once.
  for (let pass = 0; pass <= working.units.length; pass += 1) {
    const groups = new Map<string, PlayUnit[]>();
    for (const unit of working.units) {
      if (unitHp(unit) <= 0) continue;
      const position = positions.get(unit.id) ?? { col: unit.col, row: unit.row };
      const key = hexId(position.col, position.row);
      const group = groups.get(key);
      if (group) group.push(unit);
      else groups.set(key, [unit]);
    }

    let changed = false;

    for (const [key, group] of groups) {
      const owners = new Set(group.map((unit) => unit.owner));
      if (owners.size < 2) continue;

      const lead = group[0];
      if (!lead) continue;
      const position = positions.get(lead.id);
      if (!position) continue;
      const target = { col: position.col, row: position.row };
      const defender = chooseDefender(working, target, group);
      const attacker = otherPlayer(defender);

      const arrivals = group.filter(
        (unit) =>
          unit.owner === attacker &&
          movesByUnit.has(unit.id) &&
          !held.has(unit.id),
      );
      if (arrivals.length === 0) continue;

      const conflict = conflictsByHex.get(key) ?? {
        target,
        defender,
        attacks: new Map<string, ConflictAttack>(),
      };

      for (const unit of arrivals) {
        held.add(unit.id);
        const origin = { col: unit.col, row: unit.row };
        positions.set(unit.id, origin);
        const fromKey = hexId(origin.col, origin.row);
        const attack = conflict.attacks.get(fromKey) ?? {
          player: attacker,
          from: origin,
          unitIds: [],
        };
        attack.unitIds.push(unit.id);
        conflict.attacks.set(fromKey, attack);
      }

      conflictsByHex.set(key, conflict);
      changed = true;
    }

    if (!changed) break;
  }

  const conflicts: Conflict[] = [...conflictsByHex.values()].map((entry) => ({
    id: `conflict-${hexId(entry.target.col, entry.target.row)}-${state.turn}`,
    target: entry.target,
    defender: entry.defender,
    attacks: [...entry.attacks.values()],
  }));

  const units = working.units.map((unit) => {
    const position = positions.get(unit.id) ?? { col: unit.col, row: unit.row };
    const next: PlayUnit = {
      ...unit,
      col: position.col,
      row: position.row,
      moved: false,
    };
    if (unit.typeId === "worker") {
      const movedHere =
        position.col !== unit.col || position.row !== unit.row;
      next.gatherFrom = gatherForPosition(
        working,
        unit,
        position.col,
        position.row,
        harvestChoices.get(unit.id),
        !movedHere,
      );
    }
    return next;
  });

  const log: string[] = [...buildLog];
  for (const player of ["a", "b"] as Player[]) {
    const moves = accepted.filter(
      (entry) => entry.player === player && !held.has(entry.unit.id),
    );
    if (moves.length === 0) continue;
    const summary = moves
      .map(
        (entry) =>
          `${UNIT_LABEL[entry.unit.typeId]} ${tileLabel(entry.unit.col, entry.unit.row)}→${tileLabel(entry.move.col, entry.move.row)}`,
      )
      .join(", ");
    log.push(`${PLAYER_LABEL[player]} moved ${summary}.`);
  }

  for (const conflict of conflicts) {
    const attacker = conflict.attacks[0]?.player ?? otherPlayer(conflict.defender);
    log.push(
      `Conflict at ${tileLabel(conflict.target.col, conflict.target.row)}: ${PLAYER_LABEL[attacker]} attacks ${PLAYER_LABEL[conflict.defender]}.`,
    );
  }

  return { state: { ...working, units }, conflicts, log };
}

/** The side that already stood on the hex defends it; an empty clash is arbitrary. */
function chooseDefender(
  state: PlayState,
  target: HexCoord,
  group: PlayUnit[],
): Player {
  const stayed = group.find(
    (unit) => unit.col === target.col && unit.row === target.row,
  );
  if (stayed) return stayed.owner;

  const started = state.units.find(
    (unit) => unit.col === target.col && unit.row === target.row,
  );
  if (started) return started.owner;

  return "b";
}

function toCard(unit: PlayUnit): Card {
  return {
    uid: unit.id,
    typeId: unit.typeId,
    hp: unitHp(unit),
    retreating: false,
  };
}

function summarizeSurvivors(cards: SurvivingCard[]): BattleUnitSummary[] {
  return cards.map((card) => ({
    unitId: card.uid,
    typeId: card.typeId as PlayUnitType,
    hp: card.hp,
  }));
}

interface ConflictOutcome {
  units: PlayUnit[];
  report: BattleReport;
  log: string[];
}

/** Fight one conflict and return the surviving board plus a report. */
function applyConflict(current: PlayUnit[], conflict: Conflict): ConflictOutcome {
  const attacker = conflict.attacks[0]?.player ?? otherPlayer(conflict.defender);
  const attackerIds = new Set(conflict.attacks.flatMap((attack) => attack.unitIds));

  const defenders = current.filter(
    (unit) =>
      unit.owner === conflict.defender &&
      unit.col === conflict.target.col &&
      unit.row === conflict.target.row &&
      unitHp(unit) > 0,
  );
  const attackers = current.filter(
    (unit) => unit.owner === attacker && attackerIds.has(unit.id) && unitHp(unit) > 0,
  );

  const sideUnits: Record<Player, PlayUnit[]> = { a: [], b: [] };
  for (const unit of [...defenders, ...attackers]) {
    sideUnits[unit.owner].push(unit);
  }

  const targetLabel = tileLabel(conflict.target.col, conflict.target.row);
  const result = resolveBattle({
    a: {
      label: `${PLAYER_LABEL.a} at ${targetLabel}`,
      cards: sideUnits.a.map(toCard),
      hasRetreatHex: false,
    },
    b: {
      label: `${PLAYER_LABEL.b} at ${targetLabel}`,
      cards: sideUnits.b.map(toCard),
      hasRetreatHex: false,
    },
  });

  const survivorCards: Record<Player, Map<string, SurvivingCard>> = {
    a: new Map(result.survivors.a.map((card) => [card.uid, card])),
    b: new Map(result.survivors.b.map((card) => [card.uid, card])),
  };

  const defenderSurvivors = defenders.filter((unit) =>
    survivorCards[conflict.defender].has(unit.id),
  );
  const defenderHasStructures = defenderSurvivors.some(
    (unit) => getDefinition(unit.typeId).kind === "structure",
  );

  const occupied =
    result.winner === attacker && !defenderHasStructures;
  const participants = new Set(
    [...defenders, ...attackers].map((unit) => unit.id),
  );

  const units: PlayUnit[] = [];
  for (const unit of current) {
    if (!participants.has(unit.id)) {
      units.push(unit);
      continue;
    }
    const survivor = survivorCards[unit.owner].get(unit.id);
    if (!survivor) continue;

    const next: PlayUnit = { ...unit, hp: survivor.hp };
    if (occupied && unit.owner === attacker) {
      next.col = conflict.target.col;
      next.row = conflict.target.row;
    }
    units.push(next);
  }

  const report: BattleReport = {
    conflictId: conflict.id,
    target: conflict.target,
    defender: conflict.defender,
    attacker,
    winner: result.winner,
    reason: result.reason,
    loops: result.rounds.filter((round) => round.index > 0).length,
    startingUnits: result.startingUnits,
    survivors: {
      a: summarizeSurvivors(result.survivors.a),
      b: summarizeSurvivors(result.survivors.b),
    },
    rounds: result.rounds,
    occupied,
  };

  const log: string[] = [
    `Battle at ${targetLabel}: ${PLAYER_LABEL[attacker]} ${describeUnits(attackers)} vs ${PLAYER_LABEL[conflict.defender]} ${describeUnits(defenders)}.`,
  ];
  log.push(
    result.winner === "draw"
      ? `The battle at ${targetLabel} ended in a draw.`
      : `${PLAYER_LABEL[result.winner]} won the battle at ${targetLabel} — ${result.reason.toLowerCase()}`,
  );
  if (occupied) {
    log.push(`${PLAYER_LABEL[attacker]} took ${targetLabel}.`);
  } else if (defenderHasStructures) {
    log.push(
      `${PLAYER_LABEL[conflict.defender]} still holds ${targetLabel} with a structure.`,
    );
  }

  return { units, report, log };
}

function finishRound(
  state: PlayState,
  units: PlayUnit[],
  battles: BattleReport[],
  logLines: string[],
): PlayState {
  const movedState: PlayState = {
    ...state,
    units,
    phase: "planning",
    conflicts: [],
    battles,
  };

  const gainedA = harvestFor(movedState, "a");
  const gainedB = harvestFor(movedState, "b");

  const log = [...state.log, ...logLines];
  for (const player of ["a", "b"] as Player[]) {
    const gained = player === "a" ? gainedA : gainedB;
    if (gained.minerals > 0 || gained.gas > 0) {
      log.push(`${PLAYER_LABEL[player]} ${describeHarvest(gained)}.`);
    }
  }
  log.push(`Round ${state.turn + 1} begins.`);

  return {
    ...movedState,
    turn: state.turn + 1,
    stock: {
      a: {
        minerals: state.stock.a.minerals + gainedA.minerals,
        gas: state.stock.a.gas + gainedA.gas,
      },
      b: {
        minerals: state.stock.b.minerals + gainedB.minerals,
        gas: state.stock.b.gas + gainedB.gas,
      },
    },
    log: log.slice(-12),
  };
}

/**
 * Resolve a full round from both players' plans.
 *
 * Every piece steps at most once. Allied armies merge, enemy-held hexes become
 * conflicts, and an empty hex both players enter is a head-on clash. Uncontested
 * moves happen immediately; if any conflicts remain the round pauses in the
 * battle phase until resolveBattles is called. If there are no conflicts the
 * round finishes right away: Workers harvest and the next round begins.
 */
export function resolveRound(
  state: PlayState,
  submissions: RoundSubmissions,
): PlayState {
  if (state.winner || state.phase === "battle") return state;

  const plan = planRound(state, submissions);
  if (plan.conflicts.length > 0) {
    return {
      ...plan.state,
      phase: "battle",
      conflicts: plan.conflicts,
      battles: [],
      log: [...state.log, ...plan.log].slice(-12),
    };
  }

  return finishRound(plan.state, plan.state.units, [], plan.log);
}

/**
 * Resolve every conflict in the current battle phase, then finish the round.
 * The attacking survivors take a hex only when the defender is wiped out;
 * surviving structures keep the hex, exactly like the tabletop battle phase.
 */
export function resolveBattles(state: PlayState): PlayState {
  if (state.winner || state.phase !== "battle" || state.conflicts.length === 0) {
    return state;
  }

  let units = state.units.map((unit) => ({ ...unit }));
  const battles: BattleReport[] = [];
  const log: string[] = [];

  for (const conflict of state.conflicts) {
    const outcome = applyConflict(units, conflict);
    units = outcome.units;
    battles.push(outcome.report);
    log.push(...outcome.log);
  }

  return finishRound(state, units, battles, log);
}
