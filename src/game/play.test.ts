import { describe, expect, it } from "vitest";
import {
  MAP_COLS,
  MAP_ROWS,
  MAP_TILES,
  STARTING_STOCK,
  buildOptions,
  buildUnit,
  canBuild,
  canMoveTo,
  canUnitMoveTo,
  createInitialState,
  eliminationWinner,
  endTurn,
  gatherFor,
  gatherOptionsAt,
  harvestFor,
  isAdjacent,
  moveUnit,
  moveUnits,
  neighbors,
  normalizePlayState,
  resolveBattles,
  resolveRound,
  setGatherPreference,
  unitById,
  unitHp,
  unitsAt,
  type GatherFrom,
  type PlayState,
  type PlayUnit,
  type Player,
} from "./play";

/**
 * The classic one-Worker/one-Soldier layout. Movement and combat tests use it so
 * changing the real starting map does not silently rewrite their scenarios.
 */
function createSkirmishState(): PlayState {
  const state = createInitialState();
  return {
    ...state,
    units: [
      { id: "a-base", owner: "a", typeId: "base", col: 2, row: 0, moved: false },
      { id: "a-worker", owner: "a", typeId: "worker", col: 1, row: 0, moved: false },
      { id: "a-soldier", owner: "a", typeId: "soldier", col: 3, row: 0, moved: false },
      { id: "b-base", owner: "b", typeId: "base", col: 2, row: 4, moved: false },
      { id: "b-worker", owner: "b", typeId: "worker", col: 1, row: 4, moved: false },
      { id: "b-soldier", owner: "b", typeId: "soldier", col: 3, row: 4, moved: false },
    ],
  };
}

describe("starter map", () => {
  it("is a nineteen-hex large hex with a dual node at every side centre", () => {
    expect(MAP_COLS).toBe(5);
    expect(MAP_ROWS).toBe(5);
    expect(MAP_TILES).toHaveLength(19);

    const perRow = [0, 1, 2, 3, 4].map(
      (row) => MAP_TILES.filter((tile) => tile.row === row).length,
    );
    expect(perRow).toEqual([3, 4, 5, 4, 3]);

    const nodes = MAP_TILES.filter((tile) => tile.resources.length > 0);
    expect(nodes).toHaveLength(6);
    expect(nodes.map((tile) => tile.id).sort()).toEqual(
      ["0,1", "0,3", "2,0", "2,4", "3,1", "3,3"].sort(),
    );
    for (const node of nodes) {
      expect([...node.resources].sort()).toEqual(["gas", "minerals"]);
    }
  });

  it("starts the players on opposite edges", () => {
    const state = createInitialState();
    const aUnits = state.units.filter((unit) => unit.owner === "a");
    const bUnits = state.units.filter((unit) => unit.owner === "b");

    expect(aUnits.every((unit) => unit.row === 0)).toBe(true);
    expect(bUnits.every((unit) => unit.row === MAP_ROWS - 1)).toBe(true);
    expect(state.active).toBe("a");
    expect(state.turn).toBe(1);
  });

  it("starts each side with three Workers on its Base and no Soldiers", () => {
    const state = createInitialState();
    for (const player of ["a", "b"] as const) {
      const base = state.units.find(
        (unit) => unit.owner === player && unit.typeId === "base",
      );
      const workers = state.units.filter(
        (unit) => unit.owner === player && unit.typeId === "worker",
      );

      expect(base).toBeDefined();
      expect(workers).toHaveLength(3);
      expect(
        workers.every(
          (worker) =>
            worker.col === base!.col &&
            worker.row === base!.row &&
            !worker.moved,
        ),
      ).toBe(true);
      expect(
        state.units.some(
          (unit) => unit.owner === player && unit.typeId === "soldier",
        ),
      ).toBe(false);
      expect(
        MAP_TILES.find((tile) => tile.col === base!.col && tile.row === base!.row)
          ?.resources,
      ).toEqual(["minerals", "gas"]);
    }
    expect(state.units).toHaveLength(8);
  });

  it("starts each Base with three mineable Workers", () => {
    const state = createInitialState();
    expect(harvestFor(state, "a")).toEqual({ minerals: 3, gas: 0 });
    expect(harvestFor(state, "b")).toEqual({ minerals: 3, gas: 0 });
  });
});

describe("hex neighbours", () => {
  it("has six neighbours away from the edge", () => {
    expect(neighbors(2, 2)).toHaveLength(6);
  });

  it("clips neighbours at the board edge", () => {
    expect(neighbors(1, 0)).toHaveLength(3);
    expect(neighbors(0, 1)).toHaveLength(4);
    expect(isAdjacent({ col: 1, row: 0 }, { col: 0, row: 1 })).toBe(true);
    expect(isAdjacent({ col: 1, row: 0 }, { col: 4, row: 2 })).toBe(false);
  });
});

describe("movement", () => {
  it("moves an active unit one adjacent hex and blocks a second move", () => {
    const state = createSkirmishState();
    const worker = unitById(state, "a-worker");
    if (!worker) throw new Error("missing worker");

    const moved = moveUnit(state, worker.id, worker.col, worker.row + 1);

    expect(unitById(moved, worker.id)).toMatchObject({ col: 1, row: 1, moved: true });
    expect(moveUnit(moved, worker.id, 1, 2)).toBe(moved);
  });

  it("cannot move bases or enemy units, but enemy-held hexes are attack targets", () => {
    const state = createSkirmishState();
    const base = unitById(state, "a-base");
    const enemy = unitById(state, "b-worker");
    if (!base || !enemy) throw new Error("missing units");

    expect(canMoveTo(state, base, 1, 1)).toBe(false);
    expect(canMoveTo(state, enemy, 2, 3)).toBe(false);

    // Put Player B's Worker next to Player A's Worker: the hex is a legal attack.
    const blockaded = {
      ...state,
      units: state.units.map((unit) =>
        unit.id === "b-worker" ? { ...unit, col: 1, row: 1 } : unit,
      ),
    };
    const worker = unitById(blockaded, "a-worker");
    if (!worker) throw new Error("missing worker");
    expect(canUnitMoveTo(blockaded, worker, 1, 1)).toBe(true);
  });

  it("lets allied pieces stack on the same hex", () => {
    const state = createSkirmishState();
    const soldier = unitById(state, "a-soldier");
    if (!soldier) throw new Error("missing soldier");

    // A's soldier at D1 can join A's base at C1.
    expect(canMoveTo(state, soldier, 2, 0)).toBe(true);
    const moved = moveUnit(state, soldier.id, 2, 0);
    expect(unitsAt(moved, 2, 0).map((unit) => unit.id).sort()).toEqual([
      "a-base",
      "a-soldier",
    ]);
  });

  it("lets several selected pieces march together to one hex", () => {
    const state = createSkirmishState();

    const moved = moveUnits(state, ["a-worker", "a-soldier"], 2, 0);

    expect(unitsAt(moved, 2, 0).map((unit) => unit.id).sort()).toEqual([
      "a-base",
      "a-soldier",
      "a-worker",
    ]);
    expect(moved.units.filter((unit) => unit.moved)).toHaveLength(2);
  });

  it("fights immediately when a practice move enters an enemy-held hex", () => {
    const state = createSkirmishState();
    const units = state.units.map((unit) => {
      if (unit.id === "a-soldier") return { ...unit, col: 1, row: 2 };
      if (unit.id === "b-worker") return { ...unit, col: 1, row: 3 };
      return unit;
    });

    const moved = moveUnits({ ...state, units }, ["a-soldier"], 1, 3);

    expect(unitById(moved, "b-worker")).toBeUndefined();
    const soldier = unitById(moved, "a-soldier");
    expect(soldier).toMatchObject({ col: 1, row: 3 });
    expect(soldier && unitHp(soldier)).toBe(2);
    expect(moved.battles).toHaveLength(1);
    expect(moved.battles[0]).toMatchObject({ target: { col: 1, row: 3 }, occupied: true });
  });

  it("cannot move to a non-adjacent hex", () => {
    const state = createSkirmishState();
    const soldier = unitById(state, "a-soldier");
    if (!soldier) throw new Error("missing soldier");

    expect(canMoveTo(state, soldier, 2, 2)).toBe(false);
  });
});

describe("turns and harvesting", () => {
  it("collects a mineral for a Worker standing on its Base when the turn ends", () => {
    let state = createSkirmishState();
    const worker = unitById(state, "a-worker");
    const base = unitById(state, "a-base");
    if (!worker || !base) throw new Error("missing units");

    state = moveUnit(state, worker.id, base.col, base.row);
    expect(harvestFor(state, "a")).toEqual({ minerals: 1, gas: 0 });
    expect(base).toMatchObject({ col: 2, row: 0 });

    state = endTurn(state);

    expect(state.stock.a).toEqual({
      minerals: STARTING_STOCK.minerals + 1,
      gas: STARTING_STOCK.gas,
    });
    expect(state.active).toBe("b");
    expect(state.turn).toBe(1);
    expect(unitById(state, "a-worker")?.moved).toBe(true);
    expect(unitById(state, "b-worker")?.moved).toBe(false);
  });

  it("counts a completed round after Player B ends their turn", () => {
    let state = createSkirmishState();
    state = endTurn(state);
    expect(state.turn).toBe(1);

    state = endTurn(state);
    expect(state.turn).toBe(2);
    expect(state.active).toBe("a");
  });

  it("gives the incoming player a fresh move without stacking resources", () => {
    let state = createSkirmishState();
    const worker = unitById(state, "a-worker");
    const base = unitById(state, "a-base");
    if (!worker || !base) throw new Error("missing units");

    state = moveUnit(state, worker.id, base.col, base.row);
    state = endTurn(state); // B's turn, A worker harvests
    state = endTurn(state); // back to A

    expect(state.stock.a).toEqual({
      minerals: STARTING_STOCK.minerals + 1,
      gas: STARTING_STOCK.gas,
    });
    expect(unitById(state, "a-worker")?.moved).toBe(false);
    expect(unitsAt(state, base.col, base.row).map((unit) => unit.id)).toContain(
      worker.id,
    );
  });
});

describe("simultaneous rounds", () => {
  it("moves both players' units in the same round and harvests for both", () => {
    const state = createSkirmishState();

    const next = resolveRound(state, {
      a: [
        { unitId: "a-worker", col: 2, row: 0 },
        { unitId: "a-soldier", col: 3, row: 1 },
      ],
      b: [
        { unitId: "b-worker", col: 2, row: 4 },
        { unitId: "b-soldier", col: 2, row: 3 },
      ],
    });

    expect(unitById(next, "a-worker")).toMatchObject({ col: 2, row: 0 });
    expect(unitById(next, "a-soldier")).toMatchObject({ col: 3, row: 1 });
    expect(unitById(next, "b-worker")).toMatchObject({ col: 2, row: 4 });
    expect(unitById(next, "b-soldier")).toMatchObject({ col: 2, row: 3 });
    expect(next.stock).toEqual({
      a: {
        minerals: STARTING_STOCK.minerals + 1,
        gas: STARTING_STOCK.gas,
      },
      b: {
        minerals: STARTING_STOCK.minerals + 1,
        gas: STARTING_STOCK.gas,
      },
    });
    expect(next.turn).toBe(2);
    expect(unitById(next, "a-worker")?.moved).toBe(false);
  });

  it("lets several allied units enter the same hex in one round", () => {
    const state = createSkirmishState();

    const next = resolveRound(state, {
      a: [
        { unitId: "a-worker", col: 2, row: 0 },
        { unitId: "a-soldier", col: 2, row: 0 },
      ],
      b: [],
    });

    expect(unitsAt(next, 2, 0).map((unit) => unit.id).sort()).toEqual([
      "a-base",
      "a-soldier",
      "a-worker",
    ]);
  });

  it("caps a Base at five minerals per turn", () => {
    const state = createSkirmishState();
    const extraWorkers: PlayUnit[] = Array.from({ length: 7 }, (_, i) => ({
      id: `a-worker-${i + 2}`,
      owner: "a",
      typeId: "worker",
      col: 2,
      row: 0,
      moved: false,
    }));
    const units = [
      ...state.units.map((unit) =>
        unit.id === "a-worker" ? { ...unit, col: 2, row: 0 } : unit,
      ),
      ...extraWorkers,
    ];
    const stacked = { ...state, units };

    expect(harvestFor(stacked, "a")).toEqual({ minerals: 5, gas: 0 });
  });

  it("ignores forged, impossible and duplicate moves", () => {
    const state = createSkirmishState();

    const next = resolveRound(state, {
      a: [
        // Not Player A's unit.
        { unitId: "b-worker", col: 2, row: 3 },
        // Bases never move.
        { unitId: "a-base", col: 1, row: 1 },
        // Not adjacent.
        { unitId: "a-worker", col: 2, row: 2 },
        // The first move for the soldier is kept; the second is ignored.
        { unitId: "a-soldier", col: 3, row: 1 },
        { unitId: "a-soldier", col: 1, row: 0 },
      ],
      b: [],
    });

    expect(unitById(next, "b-worker")).toMatchObject({ col: 1, row: 4 });
    expect(unitById(next, "a-base")).toMatchObject({ col: 2, row: 0 });
    expect(unitById(next, "a-worker")).toMatchObject({ col: 1, row: 0 });
    expect(unitById(next, "a-soldier")).toMatchObject({ col: 3, row: 1 });
    expect(next.turn).toBe(2);
  });

  it("creates a conflict when both players enter the same empty hex", () => {
    const state = createSkirmishState();
    const units = state.units.map((unit) => {
      if (unit.id === "a-worker") return { ...unit, col: 1, row: 2 };
      if (unit.id === "b-worker") return { ...unit, col: 2, row: 3 };
      return unit;
    });

    const next = resolveRound(
      { ...state, units },
      {
        a: [{ unitId: "a-worker", col: 1, row: 3 }],
        b: [{ unitId: "b-worker", col: 1, row: 3 }],
      },
    );

    expect(next.phase).toBe("battle");
    expect(next.conflicts).toHaveLength(1);
    expect(next.conflicts[0]).toMatchObject({
      target: { col: 1, row: 3 },
      defender: "b",
    });
    // The attacker waits in its origin hex; the defender already stands on the target.
    expect(unitById(next, "a-worker")).toMatchObject({ col: 1, row: 2 });
    expect(unitById(next, "b-worker")).toMatchObject({ col: 1, row: 3 });

    const resolved = resolveBattles(next);
    expect(resolved.phase).toBe("planning");
    expect(resolved.conflicts).toHaveLength(0);
    expect(resolved.battles).toHaveLength(1);
    expect(resolved.battles[0]?.winner).toBe("draw");
    expect(resolved.battles[0]?.occupied).toBe(false);
    // Two Workers meeting head-on trade one damage each and both die.
    expect(unitById(resolved, "a-worker")).toBeUndefined();
    expect(unitById(resolved, "b-worker")).toBeUndefined();
    expect(resolved.turn).toBe(2);
  });

  it("advances the round when both sides hold position", () => {
    const state = createSkirmishState();

    const next = resolveRound(state, { a: [], b: [] });

    expect(next.turn).toBe(2);
    expect(next.units).toEqual(state.units);
    expect(next.stock).toEqual(state.stock);
  });
});

describe("conflict and battle phase", () => {
  it("moves into an enemy-held hex when the enemy vacates it", () => {
    const state = createSkirmishState();
    const units = state.units.map((unit) => {
      if (unit.id === "a-soldier") return { ...unit, col: 1, row: 2 };
      if (unit.id === "b-worker") return { ...unit, col: 1, row: 3 };
      return unit;
    });

    const next = resolveRound(
      { ...state, units },
      {
        a: [{ unitId: "a-soldier", col: 1, row: 3 }],
        b: [{ unitId: "b-worker", col: 2, row: 3 }],
      },
    );

    expect(next.phase).toBe("planning");
    expect(next.conflicts).toHaveLength(0);
    expect(unitById(next, "a-soldier")).toMatchObject({ col: 1, row: 3 });
    expect(unitById(next, "b-worker")).toMatchObject({ col: 2, row: 3 });
    expect(next.turn).toBe(2);
  });

  it("holds an attack when the enemy stays, then resolves the battle", () => {
    const state = createSkirmishState();
    const units = state.units.map((unit) => {
      if (unit.id === "a-soldier") return { ...unit, col: 1, row: 2 };
      if (unit.id === "b-worker") return { ...unit, col: 1, row: 3 };
      return unit;
    });

    const next = resolveRound(
      { ...state, units },
      { a: [{ unitId: "a-soldier", col: 1, row: 3 }], b: [] },
    );

    expect(next.phase).toBe("battle");
    expect(next.conflicts).toHaveLength(1);
    expect(next.conflicts[0]).toMatchObject({
      target: { col: 1, row: 3 },
      defender: "b",
      attacks: [{ player: "a", unitIds: ["a-soldier"] }],
    });
    expect(unitById(next, "a-soldier")).toMatchObject({ col: 1, row: 2 });
    expect(unitById(next, "b-worker")).toMatchObject({ col: 1, row: 3 });
    // The round is paused until the battle phase is resolved.
    expect(resolveRound(next, { a: [], b: [] })).toBe(next);

    const resolved = resolveBattles(next);

    expect(resolved.phase).toBe("planning");
    expect(resolved.conflicts).toHaveLength(0);
    expect(unitById(resolved, "b-worker")).toBeUndefined();
    const soldier = unitById(resolved, "a-soldier");
    expect(soldier).toMatchObject({ col: 1, row: 3 });
    // Soldier (3 HP) takes one damage from the Worker and holds the hex with 2 HP.
    expect(soldier && unitHp(soldier)).toBe(2);
    expect(resolved.battles[0]).toMatchObject({
      winner: "a",
      occupied: true,
      target: { col: 1, row: 3 },
    });
    expect(resolved.turn).toBe(2);
  });

  it("merges allied groups attacking the same hex into one battle", () => {
    const state = createSkirmishState();
    const units = state.units.map((unit) => {
      if (unit.id === "a-soldier") return { ...unit, col: 1, row: 2 };
      if (unit.id === "a-worker") return { ...unit, col: 0, row: 3 };
      if (unit.id === "b-worker") return { ...unit, col: 1, row: 3 };
      return unit;
    });

    const next = resolveRound(
      { ...state, units },
      {
        a: [
          { unitId: "a-soldier", col: 1, row: 3 },
          { unitId: "a-worker", col: 1, row: 3 },
        ],
        b: [],
      },
    );

    expect(next.phase).toBe("battle");
    expect(next.conflicts).toHaveLength(1);
    const attacks = next.conflicts[0]?.attacks ?? [];
    expect(attacks).toHaveLength(2);
    expect(attacks.flatMap((attack) => attack.unitIds).sort()).toEqual([
      "a-soldier",
      "a-worker",
    ]);

    const resolved = resolveBattles(next);
    expect(resolved.battles[0]?.winner).toBe("a");
    expect(resolved.battles[0]?.occupied).toBe(true);
    expect(unitById(resolved, "b-worker")).toBeUndefined();

    const survivors = unitsAt(resolved, 1, 3);
    expect(survivors.length).toBeGreaterThan(0);
    expect(survivors.every((unit) => unit.owner === "a")).toBe(true);
  });

  it("keeps a surviving defender structure on the contested hex", () => {
    const state = createSkirmishState();
    const units = state.units.map((unit) => {
      if (unit.id === "a-soldier") return { ...unit, col: 1, row: 1 };
      if (unit.id === "b-base") return { ...unit, col: 1, row: 2 };
      return unit;
    });

    const next = resolveRound(
      { ...state, units },
      { a: [{ unitId: "a-soldier", col: 1, row: 2 }], b: [] },
    );

    expect(next.phase).toBe("battle");

    const resolved = resolveBattles(next);
    expect(resolved.battles[0]?.winner).toBe("a");
    // A Base is a structure: even with every unit gone it keeps the hex.
    expect(resolved.battles[0]?.occupied).toBe(false);
    const base = unitById(resolved, "b-base");
    expect(base).toMatchObject({ col: 1, row: 2 });
  });

  it("backfills phase fields on states saved before battles existed", () => {
    const state = createSkirmishState();
    const legacy = { ...state } as Partial<PlayState>;
    delete legacy.phase;
    delete legacy.conflicts;
    delete legacy.battles;

    const normalized = normalizePlayState(legacy as PlayState);

    expect(normalized.phase).toBe("planning");
    expect(normalized.conflicts).toEqual([]);
    expect(normalized.battles).toEqual([]);
  });
});

describe("construction and training", () => {
  it("spends a Worker's action and stock to build on its hex", () => {
    const state = createSkirmishState();
    const next = buildUnit(state, "a", "a-worker", "refinery");

    expect(next.stock.a).toEqual({
      minerals: STARTING_STOCK.minerals - 3,
      gas: STARTING_STOCK.gas,
    });
    expect(unitById(next, "a-refinery-1")).toMatchObject({
      owner: "a",
      typeId: "refinery",
      col: 1,
      row: 0,
    });
    expect(unitById(next, "a-worker")?.moved).toBe(true);
  });

  it("lets a Base train a Worker on its own hex", () => {
    const state = createSkirmishState();
    const next = buildUnit(state, "a", "a-base", "worker");

    expect(next.stock.a).toEqual({
      minerals: STARTING_STOCK.minerals - 2,
      gas: STARTING_STOCK.gas,
    });
    expect(unitById(next, "a-worker-1")).toMatchObject({
      owner: "a",
      typeId: "worker",
      col: 2,
      row: 0,
    });
    expect(unitById(next, "a-base")?.moved).toBe(true);
    expect(unitById(next, "a-worker")?.moved).toBe(false);
  });

  it("lets a Barracks train a Soldier on its own hex", () => {
    const state = createSkirmishState();
    const barracks: PlayUnit = {
      id: "a-barracks-1",
      owner: "a",
      typeId: "barracks",
      col: 1,
      row: 0,
      moved: false,
    };
    const withBarracks: PlayState = {
      ...state,
      units: [...state.units, barracks],
      stock: { ...state.stock, a: { minerals: 10, gas: 0 } },
    };

    const next = buildUnit(withBarracks, "a", barracks.id, "soldier");

    expect(next.stock.a).toEqual({ minerals: 7, gas: 0 });
    expect(unitById(next, "a-soldier-1")).toMatchObject({
      owner: "a",
      typeId: "soldier",
      col: 1,
      row: 0,
    });
    expect(unitById(next, barracks.id)?.moved).toBe(true);
  });

  it("requires the unlocking structure before building advanced cards", () => {
    const state = createSkirmishState();
    expect(canBuild(state, "a", "a-worker", "factory")).toMatchObject({
      ok: false,
      reason: "Requires Barracks",
    });
    expect(canBuild(state, "a", "a-worker", "barracks")).toMatchObject({
      ok: false,
      reason: "Needs 5◆",
    });

    const rich = {
      ...state,
      stock: { ...state.stock, a: { minerals: 20, gas: 5 } },
    };
    const built = buildUnit(rich, "a", "a-worker", "barracks");
    expect(unitById(built, "a-barracks-1")).toBeDefined();

    // The worker spent its action; ready it again for the next round before
    // checking the newly unlocked Factory.
    const rested = {
      ...built,
      units: built.units.map((unit) =>
        unit.id === "a-worker" ? { ...unit, moved: false } : unit,
      ),
    };
    expect(canBuild(rested, "a", "a-worker", "factory").ok).toBe(true);
  });

  it("ignores a build order for a card the piece cannot make", () => {
    const state = createSkirmishState();
    const next = resolveRound(state, {
      a: { moves: [], builds: [{ builderId: "a-worker", typeId: "soldier" }] },
      b: { moves: [], builds: [] },
    });

    expect(next.units).toHaveLength(state.units.length);
    expect(next.stock.a).toEqual(state.stock.a);
  });

  it("resolves construction before movement and refreshes the builder next round", () => {
    const next = resolveRound(createSkirmishState(), {
      a: {
        moves: [{ unitId: "a-soldier", col: 2, row: 1 }],
        builds: [{ builderId: "a-worker", typeId: "refinery" }],
      },
      b: { moves: [], builds: [] },
    });

    expect(unitById(next, "a-refinery-1")).toMatchObject({ col: 1, row: 0 });
    expect(unitById(next, "a-worker")?.moved).toBe(false);
    expect(unitById(next, "a-soldier")).toMatchObject({ col: 2, row: 1 });
    expect(next.stock.a.minerals).toBe(STARTING_STOCK.minerals - 3);
  });

  it("keeps a building Worker out of the harvest for that round", () => {
    const state = createSkirmishState();
    const onBase: PlayState = {
      ...state,
      units: state.units.map((unit) =>
        unit.id === "a-worker" ? { ...unit, col: 2, row: 0 } : unit,
      ),
    };
    expect(harvestFor(onBase, "a")).toEqual({ minerals: 1, gas: 0 });

    const built = buildUnit(onBase, "a", "a-worker", "refinery");
    expect(harvestFor(built, "a")).toEqual({ minerals: 0, gas: 0 });

    const next = resolveRound(onBase, {
      a: { moves: [], builds: [{ builderId: "a-worker", typeId: "refinery" }] },
      b: { moves: [], builds: [] },
    });
    // 4◆ − 3◆ for the Refinery, with no mineral gathered by the builder.
    expect(next.stock.a.minerals).toBe(STARTING_STOCK.minerals - 3);
    expect(unitById(next, "a-worker")?.moved).toBe(false);
    expect(unitById(next, "a-worker")?.building).toBe(false);
  });

  it("lists build window options for Workers and Bases only", () => {
    const state = createSkirmishState();
    const workerOptions = buildOptions(state, "a", "a-worker");

    expect(workerOptions.map((option) => option.typeId)).toEqual(
      expect.arrayContaining(["base", "refinery", "barracks", "factory"]),
    );
    expect(
      workerOptions.find((option) => option.typeId === "factory")?.enabled,
    ).toBe(false);
    expect(
      workerOptions.find((option) => option.typeId === "refinery")?.enabled,
    ).toBe(true);

    expect(
      buildOptions(state, "a", "a-base").map((option) => option.typeId),
    ).toEqual(["worker"]);

    const withBarracks: PlayState = {
      ...state,
      units: [
        ...state.units,
        {
          id: "a-barracks-1",
          owner: "a",
          typeId: "barracks",
          col: 1,
          row: 0,
          moved: false,
        },
      ],
    };
    expect(
      buildOptions(withBarracks, "a", "a-barracks-1").map(
        (option) => option.typeId,
      ),
    ).toEqual(["soldier"]);
    expect(canBuild(withBarracks, "a", "a-barracks-1", "worker")).toMatchObject({
      ok: false,
      reason: "Barracks train Soldiers",
    });
    expect(canBuild(state, "a", "a-base", "soldier")).toMatchObject({
      ok: false,
      reason: "Bases train Workers",
    });
    expect(buildOptions(state, "a", "a-soldier")).toEqual([]);
  });
});

describe("structure harvesting", () => {
  function addStructure(
    state: PlayState,
    owner: Player,
    typeId: "base" | "refinery",
    col: number,
    row: number,
    id = `${owner}-${typeId}-test`,
  ): PlayState {
    const structure: PlayUnit = {
      id,
      owner,
      typeId,
      col,
      row,
      moved: false,
    };
    return { ...state, units: [...state.units, structure] };
  }

  /** A round-ready state with A's Worker standing on its Base + Refinery. */
  function workerOnDualHex(gatherFrom?: GatherFrom): PlayState {
    let state = addStructure(createSkirmishState(), "a", "refinery", 2, 0);
    state = moveUnit(state, "a-worker", 2, 0, gatherFrom);
    return {
      ...state,
      units: state.units.map((unit) => ({ ...unit, moved: false })),
    };
  }

  it("gathers gas from a Refinery on a gas node", () => {
    const state = addStructure(createSkirmishState(), "a", "refinery", 0, 1);
    const worker = moveUnit(state, "a-worker", 0, 1);
    const placed = unitById(worker, "a-worker");
    if (!placed) throw new Error("missing worker");

    expect(gatherOptionsAt(worker, "a", 0, 1)).toEqual(["refinery"]);
    expect(gatherFor(worker, placed)).toEqual({
      from: "refinery",
      resource: "gas",
    });
    expect(harvestFor(worker, "a")).toEqual({ minerals: 0, gas: 1 });
  });

  it("produces nothing when the structure is off a node", () => {
    const withRefinery = addStructure(
      createSkirmishState(),
      "a",
      "refinery",
      1,
      0,
    );
    expect(gatherOptionsAt(withRefinery, "a", 1, 0)).toEqual([]);
    expect(harvestFor(withRefinery, "a")).toEqual({ minerals: 0, gas: 0 });

    let withBase = addStructure(createSkirmishState(), "a", "base", 1, 1);
    withBase = {
      ...withBase,
      units: withBase.units.map((unit) =>
        unit.id === "a-worker" ? { ...unit, col: 1, row: 1 } : unit,
      ),
    };
    expect(gatherOptionsAt(withBase, "a", 1, 1)).toEqual([]);
    expect(harvestFor(withBase, "a")).toEqual({ minerals: 0, gas: 0 });
  });

  it("ignores structures owned by the other player", () => {
    const state = createSkirmishState();
    const occupied: PlayState = {
      ...state,
      units: state.units.map((unit) =>
        unit.id === "a-worker" ? { ...unit, col: 2, row: 4 } : unit,
      ),
    };
    const worker = unitById(occupied, "a-worker");
    if (!worker) throw new Error("missing worker");

    expect(gatherOptionsAt(occupied, "a", 2, 4)).toEqual([]);
    expect(gatherFor(occupied, worker)).toBeNull();
    expect(harvestFor(occupied, "a")).toEqual({ minerals: 0, gas: 0 });
  });

  it("defaults to the Base on a hex holding both structures", () => {
    const state = workerOnDualHex();
    const worker = unitById(state, "a-worker");
    if (!worker) throw new Error("missing worker");

    expect(gatherOptionsAt(state, "a", 2, 0)).toEqual(["base", "refinery"]);
    expect(worker.gatherFrom).toBe("base");
    expect(gatherFor(state, worker)).toEqual({
      from: "base",
      resource: "minerals",
    });
    expect(harvestFor(state, "a")).toEqual({ minerals: 1, gas: 0 });
  });

  it("remembers the structure chosen when moving onto a dual hex", () => {
    let state = addStructure(createSkirmishState(), "a", "refinery", 2, 0);
    state = moveUnit(state, "a-worker", 2, 0, "refinery");
    const worker = unitById(state, "a-worker");
    if (!worker) throw new Error("missing worker");

    expect(worker.gatherFrom).toBe("refinery");
    expect(gatherFor(state, worker)).toEqual({
      from: "refinery",
      resource: "gas",
    });
    expect(harvestFor(state, "a")).toEqual({ minerals: 0, gas: 1 });
  });

  it("re-picks a stationary Worker's structure without spending its move", () => {
    const before = workerOnDualHex();
    const state = setGatherPreference(before, "a", "a-worker", "refinery");

    expect(unitById(state, "a-worker")).toMatchObject({
      moved: false,
      gatherFrom: "refinery",
    });
    expect(harvestFor(state, "a")).toEqual({ minerals: 0, gas: 1 });
  });

  it("applies a choice sent with a simultaneous move", () => {
    const state = addStructure(createSkirmishState(), "a", "refinery", 2, 0);
    const next = resolveRound(state, {
      a: {
        moves: [{ unitId: "a-worker", col: 2, row: 0 }],
        builds: [],
        harvests: [{ unitId: "a-worker", gatherFrom: "refinery" }],
      },
      b: { moves: [], builds: [] },
    });

    expect(unitById(next, "a-worker")).toMatchObject({
      col: 2,
      row: 0,
      gatherFrom: "refinery",
    });
    expect(next.stock.a).toEqual({
      minerals: STARTING_STOCK.minerals,
      gas: STARTING_STOCK.gas + 1,
    });
  });

  it("applies a stationary re-pick submitted for the round", () => {
    const next = resolveRound(workerOnDualHex("base"), {
      a: {
        moves: [],
        builds: [],
        harvests: [{ unitId: "a-worker", gatherFrom: "refinery" }],
      },
      b: { moves: [], builds: [] },
    });

    expect(unitById(next, "a-worker")).toMatchObject({
      col: 2,
      row: 0,
      gatherFrom: "refinery",
    });
    expect(next.stock.a).toEqual({
      minerals: STARTING_STOCK.minerals,
      gas: STARTING_STOCK.gas + 1,
    });
  });

  it("ignores a choice when the destination has only one structure", () => {
    const next = resolveRound(createSkirmishState(), {
      a: {
        moves: [{ unitId: "a-worker", col: 2, row: 0 }],
        builds: [],
        harvests: [{ unitId: "a-worker", gatherFrom: "refinery" }],
      },
      b: { moves: [], builds: [] },
    });

    expect(unitById(next, "a-worker")).toMatchObject({
      col: 2,
      row: 0,
      gatherFrom: "base",
    });
    expect(next.stock.a).toEqual({
      minerals: STARTING_STOCK.minerals + 1,
      gas: STARTING_STOCK.gas,
    });
  });

  it("clears the remembered choice when the Worker leaves a dual hex", () => {
    const next = resolveRound(workerOnDualHex("refinery"), {
      a: { moves: [{ unitId: "a-worker", col: 3, row: 0 }], builds: [] },
      b: { moves: [], builds: [] },
    });

    expect(unitById(next, "a-worker")).toMatchObject({ col: 3, row: 0 });
    expect(unitById(next, "a-worker")?.gatherFrom).toBeUndefined();
    expect(next.stock.a).toEqual(STARTING_STOCK);
  });

  it("caps each structure at its own income limit", () => {
    const state = addStructure(createSkirmishState(), "a", "refinery", 2, 0);
    const workers: PlayUnit[] = [
      ...Array.from({ length: 8 }, (_, index) => ({
        id: `a-worker-base-${index}`,
        owner: "a" as const,
        typeId: "worker" as const,
        col: 2,
        row: 0,
        moved: false,
        gatherFrom: "base" as const,
      })),
      ...Array.from({ length: 4 }, (_, index) => ({
        id: `a-worker-gas-${index}`,
        owner: "a" as const,
        typeId: "worker" as const,
        col: 2,
        row: 0,
        moved: false,
        gatherFrom: "refinery" as const,
      })),
    ];
    const stacked: PlayState = {
      ...state,
      units: [
        ...state.units.filter(
          (unit) => unit.owner !== "a" || unit.typeId !== "worker",
        ),
        ...workers,
      ],
    };

    expect(harvestFor(stacked, "a")).toEqual({ minerals: 5, gas: 3 });
  });

  it("accepts per-Worker gather assignments when a stack enters a dual hex", () => {
    const state = createInitialState();
    const movers = ["a-worker", "a-worker-2"].map((id) => ({
      ...state.units.find((unit) => unit.id === id)!,
      col: 2,
      row: 1,
    }));
    const staged: PlayState = {
      ...state,
      units: [
        ...state.units.filter((unit) => !movers.some((mover) => mover.id === unit.id)),
        ...movers,
        { id: "a-dual-base", owner: "a", typeId: "base", col: 3, row: 1, moved: false },
        {
          id: "a-dual-refinery",
          owner: "a",
          typeId: "refinery",
          col: 3,
          row: 1,
          moved: false,
        },
      ],
    };

    const next = moveUnits(
      staged,
      movers.map((unit) => unit.id),
      3,
      1,
      undefined,
      { "a-worker": "refinery", "a-worker-2": "base" },
    );

    expect(unitById(next, "a-worker")?.gatherFrom).toBe("refinery");
    expect(unitById(next, "a-worker-2")?.gatherFrom).toBe("base");
    expect(harvestFor(next, "a")).toEqual({ minerals: 2, gas: 1 });
  });
});

describe("elimination", () => {
  const base = (id: string, owner: Player, col: number, row: number): PlayUnit => ({
    id,
    owner,
    typeId: "base",
    col,
    row,
    moved: false,
  });

  const soldiers = (owner: Player, col: number, row: number): PlayUnit[] =>
    Array.from({ length: 4 }, (_, index) => ({
      id: `${owner}-attacker-${index}`,
      owner,
      typeId: "soldier" as const,
      col,
      row,
      moved: false,
    }));

  it("reads the winner from the structures left on the board", () => {
    const aBase = base("a-base", "a", 2, 0);
    const bBase = base("b-base", "b", 2, 4);
    const worker: PlayUnit = {
      id: "a-worker",
      owner: "a",
      typeId: "worker",
      col: 2,
      row: 0,
      moved: false,
    };

    expect(eliminationWinner([aBase, bBase])).toBeNull();
    expect(eliminationWinner([aBase, worker])).toBe("a");
    expect(eliminationWinner([bBase, worker])).toBe("b");
    expect(eliminationWinner([worker])).toBe("draw");
  });

  it("eliminates a player after immediate practice combat", () => {
    const state = createInitialState();
    const attackers = soldiers("a", 1, 2);
    const units: PlayUnit[] = [
      base("a-base", "a", 2, 0),
      base("b-last-base", "b", 1, 3),
      ...attackers,
      { id: "b-scout", owner: "b", typeId: "soldier", col: 3, row: 4, moved: false },
    ];
    const next = moveUnits(
      { ...state, units },
      attackers.map((unit) => unit.id),
      1,
      3,
    );

    expect(unitById(next, "b-last-base")).toBeUndefined();
    expect(next.winner).toBe("a");
    expect(next.log.some((line) => line.includes("eliminated"))).toBe(true);
    // A finished match accepts no more moves or turns.
    expect(moveUnits(next, ["b-scout"], 3, 3)).toBe(next);
    expect(endTurn(next)).toBe(next);
  });

  it("eliminates a player when the host resolves the battle phase", () => {
    const state = createInitialState();
    const attackers = soldiers("a", 1, 2);
    const units: PlayUnit[] = [
      base("a-base", "a", 1, 2),
      base("b-last-base", "b", 1, 3),
      ...attackers,
    ];
    const battle = resolveRound(
      { ...state, units },
      {
        a: attackers.map((unit) => ({ unitId: unit.id, col: 1, row: 3 })),
        b: [],
      },
    );

    expect(battle.phase).toBe("battle");
    const resolved = resolveBattles(battle);

    expect(unitById(resolved, "b-last-base")).toBeUndefined();
    expect(resolved.winner).toBe("a");
    expect(resolved.log.some((line) => line.includes("eliminated"))).toBe(true);
    expect(resolveBattles(resolved)).toBe(resolved);
    expect(resolveRound(resolved, { a: [], b: [] })).toBe(resolved);
  });

  it("calls it a draw when both sides lose their last structure", () => {
    const state = createInitialState();
    const aAttackers = soldiers("a", 2, 2);
    const bAttackers = soldiers("b", 0, 3);
    const units: PlayUnit[] = [
      base("a-last-base", "a", 1, 2),
      base("b-last-base", "b", 1, 3),
      ...aAttackers,
      ...bAttackers,
    ];
    const battle = resolveRound(
      { ...state, units },
      {
        a: aAttackers.map((unit) => ({ unitId: unit.id, col: 1, row: 3 })),
        b: bAttackers.map((unit) => ({ unitId: unit.id, col: 1, row: 2 })),
      },
    );

    expect(battle.phase).toBe("battle");
    expect(battle.conflicts).toHaveLength(2);

    const resolved = resolveBattles(battle);
    expect(unitById(resolved, "a-last-base")).toBeUndefined();
    expect(unitById(resolved, "b-last-base")).toBeUndefined();
    expect(resolved.winner).toBe("draw");
    expect(resolved.log.some((line) => line.includes("draw"))).toBe(true);
  });
});
