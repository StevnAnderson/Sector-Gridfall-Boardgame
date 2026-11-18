import { useEffect, useRef, useState } from "react";
import { getDefinition } from "../game/codex";
import {
  MAP_COLS,
  MAP_ROWS,
  MAP_TILES,
  PLAYER_LABEL,
  UNIT_LABEL,
  buildOptions,
  buildUnit,
  canMoveTo,
  canUnitMoveTo,
  createInitialState,
  describeCost,
  endTurn,
  gatherOptionsAt,
  harvestFor,
  moveUnits,
  normalizePlayState,
  otherPlayer,
  resolveBattles,
  resolveRound,
  setGatherPreference,
  tileLabel,
  unitById,
  unitHp,
  unitsAt,
  type BattleReport,
  type BuildOption,
  type BuildOrder,
  type Conflict,
  type GatherFrom,
  type HarvestChoice,
  type MapTile,
  type PlayMove,
  type PlayState,
  type PlayUnit,
  type PlayUnitType,
  type Player,
} from "../game/play";
import {
  CODE_LENGTH,
  hostMatch,
  joinMatch,
  normalizeCode,
  type MatchHandle,
} from "../lib/match";
import { useLocalStorage } from "../lib/useLocalStorage";
import { SectionHeading, Tag, typeColor } from "./ui";
import { ChessVariants } from "./ChessVariants";
import type { ChessVariantId } from "../game/chessVariants";

const HEX_W = 76;
const HEX_H = 88;
const ROW_STEP = HEX_H * 0.75;

const BOARD_W = MAP_COLS * HEX_W + HEX_W / 2;
const BOARD_H = (MAP_ROWS - 1) * ROW_STEP + HEX_H;

const RESOURCE_GLYPH = {
  minerals: "◆",
  gas: "▲",
} as const;

function stockSummary(gained: { minerals: number; gas: number }): string {
  const parts: string[] = [];
  if (gained.minerals > 0) {
    parts.push(`${gained.minerals} mineral${gained.minerals === 1 ? "" : "s"}`);
  }
  if (gained.gas > 0) {
    parts.push(`${gained.gas} gas`);
  }
  return parts.length > 0 ? parts.join(" + ") : "nothing";
}

function hexCenter(col: number, row: number): { x: number; y: number } {
  return {
    x: col * HEX_W + (row % 2 === 1 ? HEX_W / 2 : 0) + HEX_W / 2,
    y: row * ROW_STEP + HEX_H / 2,
  };
}

/**
 * Selection is limited to pieces standing on one hex so they can march
 * together. A stacked row in the hex panel passes every piece it represents.
 */
function toggleSelectedIds(
  state: PlayState,
  current: string[],
  unitIds: string[],
): string[] {
  const units = unitIds
    .map((id) => unitById(state, id))
    .filter((unit): unit is PlayUnit => unit !== undefined);
  if (units.length === 0) return current;

  const [col, row] = [units[0]!.col, units[0]!.row];
  const otherHex = current.some((id) => {
    const other = unitById(state, id);
    return other && (other.col !== col || other.row !== row);
  });
  if (otherHex) return [...unitIds];

  // Structures cannot march, and their window only opens for one piece, so a
  // structure is always selected on its own.
  const isStructure = units.some(
    (unit) => getDefinition(unit.typeId).kind === "structure",
  );
  const groupSelected = unitIds.every((id) => current.includes(id));
  if (isStructure) {
    return groupSelected ? [] : [...unitIds];
  }
  const currentHasStructure = current.some((id) => {
    const other = unitById(state, id);
    return other && getDefinition(other.typeId).kind === "structure";
  });
  if (currentHasStructure) return [...unitIds];

  return groupSelected
    ? current.filter((id) => !unitIds.includes(id))
    : [...current, ...unitIds.filter((id) => !current.includes(id))];
}

function unitGroupLabel(state: PlayState, unitIds: string[]): string {
  const counts = new Map<string, number>();
  for (const id of unitIds) {
    const unit = unitById(state, id);
    if (!unit) continue;
    const name = UNIT_LABEL[unit.typeId];
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  if (counts.size === 0) return "no pieces";
  return [...counts.entries()]
    .map(([name, count]) => (count === 1 ? name : `${name} x${count}`))
    .join(" + ");
}

/** Stack label for the hex panel, e.g. "Soldier x3" or "Worker (Base) x2". */
function stackLabel(
  typeId: PlayUnitType,
  assignment: GatherFrom | null,
  count: number,
  status: StackStatus = null,
): string {
  const base = UNIT_LABEL[typeId];
  const name = status
    ? `${base} (${status})`
    : assignment
      ? `${base} (${assignment === "base" ? "Base" : "Refinery"})`
      : base;
  return count > 1 ? `${name} x${count}` : name;
}

type StackStatus = "moving" | "building" | null;

interface UnitStack {
  typeId: PlayUnitType;
  assignment: GatherFrom | null;
  status: StackStatus;
  units: PlayUnit[];
}

/** The structure a Worker will gather from after its queued move, if any. */
function gatherAssignmentFor(
  state: PlayState,
  unit: PlayUnit,
  draft: PlayMove[],
  harvests: HarvestChoice[],
): GatherFrom | null {
  if (unit.typeId !== "worker") return null;
  const order = draft.find((move) => move.unitId === unit.id);
  const col = order?.col ?? unit.col;
  const row = order?.row ?? unit.row;
  const options = gatherOptionsAt(state, unit.owner, col, row);
  if (options.length === 0) return null;
  if (options.length === 1) return options[0] ?? "base";
  const choice = harvests.find((entry) => entry.unitId === unit.id)?.gatherFrom;
  return choice ?? unit.gatherFrom ?? "base";
}

/**
 * Group pieces from one hex into the rows shown in the inspector. Mobile pieces
 * of the same kind share a row; Workers are separated by assignment, and—when
 * `withStatus` is set—by whether they are moving or building this round.
 */
function buildStacks(
  state: PlayState,
  units: PlayUnit[],
  draft: PlayMove[],
  builds: BuildOrder[],
  harvests: HarvestChoice[],
  withStatus = false,
): UnitStack[] {
  const map = new Map<string, UnitStack>();
  for (const unit of units) {
    const structure = getDefinition(unit.typeId).kind === "structure";
    const status: StackStatus =
      withStatus && !structure
        ? unit.building || builds.some((order) => order.builderId === unit.id)
          ? "building"
          : draft.some((move) => move.unitId === unit.id)
            ? "moving"
            : null
        : null;
    const assignment =
      structure || status !== null
        ? null
        : gatherAssignmentFor(state, unit, draft, harvests);
    const key = structure
      ? `piece:${unit.id}`
      : status !== null
        ? `${unit.typeId}:${status}`
        : `${unit.typeId}:${assignment ?? ""}`;
    const stack = map.get(key) ?? {
      typeId: unit.typeId,
      assignment,
      status,
      units: [],
    };
    stack.units.push(unit);
    map.set(key, stack);
  }
  return [...map.values()];
}

/** Selected stacks, split by kind and assignment, offered to a pending move. */
function movementStacks(
  state: PlayState,
  units: PlayUnit[],
  draft: PlayMove[],
  harvests: HarvestChoice[],
): UnitStack[] {
  return buildStacks(state, units, draft, [], harvests);
}

type PlayMode = "starter" | ChessVariantId;

/** A pending Base/Refinery pick, either for a move or a stationary re-pick. */
interface PendingGather {
  unitIds: string[];
  col: number;
  row: number;
  tileId: string;
  move: boolean;
}

/** A move waiting for the player to choose how many pieces leave the hex. */
interface PendingMove {
  tileId: string;
  col: number;
  row: number;
  stacks: UnitStack[];
}

/**
 * The Play tab opens on a matching screen. Hosting reserves a short code;
 * joining connects to that code and hands the board to both players. The
 * local hotseat games from earlier versions are still reachable through
 * "Practice locally".
 */
export function Play() {
  const [practice, setPractice] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  if (practice) {
    return <PracticePlay onBack={() => setPractice(false)} />;
  }

  return (
    <MatchFlow
      notice={notice}
      onNotice={setNotice}
      onPractice={() => setPractice(true)}
    />
  );
}

function MatchFlow({
  notice,
  onNotice,
  onPractice,
}: {
  notice: string | null;
  onNotice: (notice: string | null) => void;
  onPractice: () => void;
}) {
  const [match, setMatch] = useState<MatchHandle | null>(null);
  const [state, setState] = useState<PlayState | null>(null);
  const [hostCode, setHostCode] = useState<string | null>(null);
  const [busy, setBusy] = useState<"host" | "join" | null>(null);
  const [joinCode, setJoinCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [opponentReady, setOpponentReady] = useState(false);

  const matchRef = useRef<MatchHandle | null>(null);
  const stateRef = useRef<PlayState | null>(null);
  const pendingRef = useRef<{
    a: { moves: PlayMove[]; builds: BuildOrder[]; harvests: HarvestChoice[] } | null;
    b: { moves: PlayMove[]; builds: BuildOrder[]; harvests: HarvestChoice[] } | null;
  }>({
    a: null,
    b: null,
  });

  const rememberState = (next: PlayState | null) => {
    if (!next || next.turn !== stateRef.current?.turn) {
      pendingRef.current = { a: null, b: null };
      setOpponentReady(false);
    }
    stateRef.current = next;
    setState(next);
  };

  const resolveIfReady = (handle: MatchHandle) => {
    const current = stateRef.current;
    const pending = pendingRef.current;
    if (!current || !pending.a || !pending.b) return;

    const next = resolveRound(current, { a: pending.a, b: pending.b });
    pendingRef.current = { a: null, b: null };
    rememberState(next);
    handle.send({ kind: "state", state: next });
  };

  const submitMoves = (
    moves: PlayMove[],
    builds: BuildOrder[],
    harvests: HarvestChoice[],
  ) => {
    const handle = matchRef.current;
    if (!handle) return;

    if (handle.role === "host") {
      pendingRef.current.a = { moves, builds, harvests };
      // Let the guest know the host is waiting on them. If the guest submitted
      // first, the round resolves right away instead.
      if (!pendingRef.current.b) handle.send({ kind: "ready", player: "a" });
      resolveIfReady(handle);
      return;
    }

    handle.send({
      kind: "action",
      action: { type: "submit", moves, builds, harvests },
    });
  };

  /** Host-only: finish the battle phase, then broadcast the next round. */
  const resolveBattlePhase = () => {
    const handle = matchRef.current;
    const current = stateRef.current;
    if (!handle || handle.role !== "host") return;
    if (!current || current.phase !== "battle") return;

    const next = resolveBattles(current);
    rememberState(next);
    handle.send({ kind: "state", state: next });
  };

  const finish = (reason: string, leaveDelay = 0) => {
    const current = matchRef.current;
    matchRef.current = null;
    if (current) {
      // The match is over locally; late transport events must not overwrite
      // the result (for example "opponent left" after a forfeit).
      current.onPaired = null;
      current.onState = null;
      current.onMessage = null;
      current.onEnd = null;
      current.onError = null;
    }
    rememberState(null);
    setMatch(null);
    setHostCode(null);
    setBusy(null);
    onNotice(reason);

    if (leaveDelay > 0) {
      window.setTimeout(() => current?.leave(), leaveDelay);
    } else {
      current?.leave();
    }
  };

  // An elimination arrives as ordinary match state from the host. End the
  // online match on both tabs as soon as the result appears.
  useEffect(() => {
    const winner = state?.winner;
    if (!winner) return;
    finish(
      winner === "draw"
        ? "Both players lost all their structures — the game is a draw."
        : `${PLAYER_LABEL[winner]} wins — ${PLAYER_LABEL[otherPlayer(winner)]} lost all structures.`,
    );
    // finish only touches refs and setters; the winner is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.winner]);

  useEffect(
    () => () => {
      matchRef.current?.leave();
    },
    [],
  );

  const host = async () => {
    setError(null);
    onNotice(null);
    setBusy("host");
    setHostCode(null);

    try {
      const handle = await hostMatch(createInitialState());
      matchRef.current = handle;
      setHostCode(handle.code);

      handle.onPaired = () => {
        if (handle.startState) rememberState(handle.startState);
        setBusy(null);
        setMatch(handle);
      };
      handle.onState = (next) => rememberState(next);
      handle.onMessage = (message) => {
        if (message.kind !== "action" || message.action.type !== "submit") return;
        pendingRef.current.b = {
          moves: message.action.moves,
          builds: message.action.builds ?? [],
          harvests: message.action.harvests ?? [],
        };
        setOpponentReady(true);
        resolveIfReady(handle);
      };
      handle.onEnd = (reason) => finish(reason);
      handle.onError = (message) => setError(message);
    } catch (err) {
      setBusy(null);
      setError(err instanceof Error ? err.message : "Could not host a game.");
    }
  };

  const cancelHost = () => {
    const current = matchRef.current;
    matchRef.current = null;
    current?.leave();
    setHostCode(null);
    setBusy(null);
  };

  const join = async (event: React.FormEvent) => {
    event.preventDefault();
    const code = normalizeCode(joinCode);
    if (code.length !== CODE_LENGTH) {
      setError(`Enter the full ${CODE_LENGTH}-character game code.`);
      return;
    }

    setError(null);
    onNotice(null);
    setBusy("join");

    try {
      const handle = await joinMatch(code);
      matchRef.current = handle;
      handle.onState = (next) => {
        rememberState(next);
        setBusy(null);
        setMatch(handle);
      };
      handle.onMessage = (message) => {
        if (message.kind === "ready") setOpponentReady(true);
      };
      handle.onEnd = (reason) => finish(reason);
      handle.onError = (message) => setError(message);

      // A fast host can send the welcome before the callbacks above exist.
      if (handle.lastState) {
        rememberState(handle.lastState);
        setBusy(null);
        setMatch(handle);
      }
    } catch (err) {
      setBusy(null);
      setError(err instanceof Error ? err.message : "Could not join that game.");
    }
  };

  if (match && state) {
    return (
      <OnlineStarter
        match={match}
        state={state}
        opponentReady={opponentReady}
        onSubmit={submitMoves}
        onResolveBattles={resolveBattlePhase}
        onFinish={finish}
      />
    );
  }

  return (
    <div className="stack">
      <SectionHeading eyebrow="Two-player skirmish" title="Play">
        <Tag>{match ? "connected" : "matchmaking"}</Tag>
      </SectionHeading>

      <section className="panel match-panel">
        <div className="match-hero">
          <span className="eyebrow">Host or join</span>
          <h2>Get both players on the same board</h2>
          <p className="muted">
            One player hosts a game and shares the five-character code. The other
            enters that code to join. The board opens for both of you as soon as
            you are paired.
          </p>
        </div>

        {notice && (
          <p className="match-notice" role="status">
            {notice}
          </p>
        )}

        <div className="match-grid">
          <div className="match-card">
            <h3>Host Game</h3>
            <p className="muted small">
              Create a room together, then send the code to your opponent.
            </p>
            {hostCode ? (
              <div className="match-waiting">
                <span className="match-code" aria-label={`Game code ${hostCode}`}>
                  {hostCode}
                </span>
                <span className="muted small">Waiting for your opponent…</span>
                <button className="btn ghost" type="button" onClick={cancelHost}>
                  Cancel
                </button>
              </div>
            ) : (
              <button
                className="btn primary"
                type="button"
                onClick={host}
                disabled={busy !== null}
              >
                {busy === "host" ? "Creating room…" : "Host Game"}
              </button>
            )}
          </div>

          <div className="match-card">
            <h3>Join Game</h3>
            <p className="muted small">Enter the code the host gave you.</p>
            <form className="match-join" onSubmit={join}>
              <input
                className="match-code-input"
                value={joinCode}
                onChange={(event) => setJoinCode(normalizeCode(event.target.value))}
                placeholder="CODE"
                aria-label="Game code"
                maxLength={CODE_LENGTH}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
              />
              <button
                className="btn"
                type="submit"
                disabled={
                  busy !== null || normalizeCode(joinCode).length !== CODE_LENGTH
                }
              >
                {busy === "join" ? "Joining…" : "Join Game"}
              </button>
            </form>
          </div>
        </div>

        {error && (
          <p className="match-error" role="alert">
            {error}
          </p>
        )}

        <div className="match-footer">
          <span className="muted small">
            Paired players connect directly. Tabs in this browser pair locally.
          </span>
          <button className="btn ghost" type="button" onClick={onPractice}>
            Practice locally
          </button>
        </div>
      </section>
    </div>
  );
}

function OnlineStarter({
  match,
  state,
  opponentReady,
  onSubmit,
  onResolveBattles,
  onFinish,
}: {
  match: MatchHandle;
  state: PlayState;
  opponentReady: boolean;
  onSubmit: (moves: PlayMove[], builds: BuildOrder[], harvests: HarvestChoice[]) => void;
  onResolveBattles: () => void;
  onFinish: (reason: string, leaveDelay?: number) => void;
}) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<PlayMove[]>([]);
  const [builds, setBuilds] = useState<BuildOrder[]>([]);
  const [harvests, setHarvests] = useState<HarvestChoice[]>([]);
  const [pendingGather, setPendingGather] = useState<PendingGather | null>(null);
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const me = match.player;
  const opponent = otherPlayer(me);
  const canResolve = match.role === "host";
  const selectedUnits = selectedIds
    .map((id) => unitById(state, id))
    .filter((unit): unit is PlayUnit => unit !== undefined);
  const inspectedTile = inspectedId
    ? MAP_TILES.find((tile) => tile.id === inspectedId)
    : undefined;
  const orders = draft
    .map((move) => ({ move, unit: unitById(state, move.unitId) }))
    .filter(
      (entry): entry is { move: PlayMove; unit: PlayUnit } =>
        entry.unit !== undefined,
    );
  const buildOrders = builds
    .map((order) => ({ order, unit: unitById(state, order.builderId) }))
    .filter(
      (entry): entry is { order: BuildOrder; unit: PlayUnit } =>
        entry.unit !== undefined,
    );
  const harvestOrders = harvests
    .map((choice) => ({ choice, unit: unitById(state, choice.unitId) }))
    .filter(
      (entry): entry is { choice: HarvestChoice; unit: PlayUnit } =>
        entry.unit !== undefined &&
        !draft.some((move) => move.unitId === entry.choice.unitId),
    );
  const queuedCount = orders.length + buildOrders.length + harvestOrders.length;

  // A new round means both plans resolved; clear the local submission.
  useEffect(() => {
    setSelectedIds([]);
    setDraft([]);
    setBuilds([]);
    setHarvests([]);
    setPendingGather(null);
    setPendingMove(null);
    setSubmitted(false);
  }, [state.turn]);

  // The battle phase locks planning. Drop the queued markers so the board shows
  // the conflict itself rather than orders that were held at the border.
  useEffect(() => {
    if (state.phase === "battle") {
      setSelectedIds([]);
      setDraft([]);
      setBuilds([]);
      setHarvests([]);
      setPendingGather(null);
      setPendingMove(null);
    }
  }, [state.phase]);

  const removeOrder = (unitId: string) => {
    setDraft((current) => current.filter((move) => move.unitId !== unitId));
    setHarvests((current) => current.filter((choice) => choice.unitId !== unitId));
  };

  const removeBuild = (builderId: string) => {
    setBuilds((current) => current.filter((order) => order.builderId !== builderId));
  };

  const removeHarvest = (unitId: string) => {
    setHarvests((current) => current.filter((choice) => choice.unitId !== unitId));
  };

  const addBuild = (builderId: string, typeId: PlayUnitType) => {
    if (submitted || state.phase === "battle") return;
    // One action per piece: a build replaces that piece's queued move.
    setDraft((current) => current.filter((move) => move.unitId !== builderId));
    setBuilds((current) => [
      ...current.filter((order) => order.builderId !== builderId),
      { builderId, typeId },
    ]);
    // Keep any other selected Workers so the next one can build too.
    setSelectedIds((current) => current.filter((id) => id !== builderId));
  };

  /** Queue a group move, optionally recording each Worker's gather choice. */
  const queueMoves = (
    unitIds: string[],
    tile: MapTile,
    gatherFrom?: GatherFrom,
  ) => {
    const ids = new Set(unitIds);
    const workers = unitIds
      .map((id) => unitById(state, id))
      .filter((unit): unit is PlayUnit => unit?.typeId === "worker");

    setDraft((current) => [
      ...current.filter((move) => !ids.has(move.unitId)),
      ...unitIds.map((unitId) => ({
        unitId,
        col: tile.col,
        row: tile.row,
      })),
    ]);
    setBuilds((current) => current.filter((order) => !ids.has(order.builderId)));
    // A moved Worker's old gather choice never carries to its new hex.
    setHarvests((current) => [
      ...current.filter((choice) => !ids.has(choice.unitId)),
      ...(gatherFrom
        ? workers.map((unit) => ({ unitId: unit.id, gatherFrom }))
        : []),
    ]);
    setSelectedIds([]);
    setInspectedId(tile.id);
    setPendingGather(null);
    setPendingMove(null);
  };

  /** Move now, or ask for a Base/Refinery assignment when the hex offers both. */
  const beginMove = (tile: MapTile, unitIds: string[]) => {
    if (unitIds.length === 0) return;
    const hasWorker = unitIds.some(
      (id) => unitById(state, id)?.typeId === "worker",
    );
    const gatherOptions = gatherOptionsAt(state, me, tile.col, tile.row);
    if (hasWorker && gatherOptions.length > 1) {
      setPendingGather({
        unitIds,
        col: tile.col,
        row: tile.row,
        tileId: tile.id,
        move: true,
      });
      setInspectedId(tile.id);
      return;
    }
    queueMoves(unitIds, tile);
  };

  const confirmMoveCount = (counts: number[]) => {
    const pending = pendingMove;
    if (!pending) return;
    const unitIds = pending.stacks.flatMap((stack, index) =>
      stack.units.slice(0, counts[index] ?? stack.units.length).map((unit) => unit.id),
    );
    setPendingMove(null);
    const tile = MAP_TILES.find((entry) => entry.id === pending.tileId);
    if (tile) beginMove(tile, unitIds);
  };

  const chooseGather = (gatherFrom: GatherFrom) => {
    const pending = pendingGather;
    if (!pending) return;

    if (pending.move) {
      const tile = MAP_TILES.find((entry) => entry.id === pending.tileId);
      if (tile) queueMoves(pending.unitIds, tile, gatherFrom);
      return;
    }

    const unitId = pending.unitIds[0];
    if (unitId) {
      setHarvests((current) => [
        ...current.filter((choice) => choice.unitId !== unitId),
        { unitId, gatherFrom },
      ]);
    }
    setPendingGather(null);
    setInspectedId(pending.tileId);
  };

  const toggleSelection = (unitIds: string[]) => {
    setSelectedIds((current) => toggleSelectedIds(state, current, unitIds));
  };

  const onTileClick = (tile: MapTile) => {
    if (submitted || state.phase === "battle") {
      setInspectedId(tile.id);
      return;
    }

    const group = selectedUnits;
    const onlyUnit = group.length === 1 ? group[0] : undefined;

    // Selecting a Worker's own dual hex re-picks its structure instead of
    // trying to move it onto itself.
    if (
      onlyUnit &&
      onlyUnit.typeId === "worker" &&
      onlyUnit.col === tile.col &&
      onlyUnit.row === tile.row &&
      gatherOptionsAt(state, me, tile.col, tile.row).length > 1
    ) {
      setPendingGather({
        unitIds: [onlyUnit.id],
        col: tile.col,
        row: tile.row,
        tileId: tile.id,
        move: false,
      });
      setInspectedId(tile.id);
      return;
    }

    const canGroupMove =
      group.length > 0 &&
      group.every((unit) => canUnitMoveTo(state, unit, tile.col, tile.row));

    if (canGroupMove) {
      const stacks = movementStacks(state, group, draft, harvests);
      if (stacks.some((stack) => stack.units.length > 1)) {
        setPendingMove({
          tileId: tile.id,
          col: tile.col,
          row: tile.row,
          stacks,
        });
        setInspectedId(tile.id);
        return;
      }
      beginMove(tile, group.map((unit) => unit.id));
      return;
    }

    // Clicking any hex inspects it. Own hexes list their pieces; enemy hexes
    // deliberately reveal nothing about the stack inside until a battle starts.
    setInspectedId(tile.id);
  };

  const submit = () => {
    if (submitted) return;
    setSubmitted(true);
    setSelectedIds([]);
    setPendingGather(null);
    setPendingMove(null);
    onSubmit(draft, builds, harvests);
  };

  const forfeit = () => {
    const winner = otherPlayer(me);
    match.send({ kind: "forfeit", player: me });
    onFinish(
      `${PLAYER_LABEL[me]} forfeited. ${PLAYER_LABEL[winner]} wins.`,
      250,
    );
  };

  const status =
    state.phase === "battle"
      ? canResolve
        ? "Armies are locked in conflict. Resolve the battles to finish the round."
        : "Waiting for the host to resolve the battles…"
      : submitted
        ? `Orders submitted. Waiting for ${PLAYER_LABEL[opponent]}…`
        : opponentReady
          ? `${PLAYER_LABEL[opponent]} has submitted. Send your orders when ready.`
          : selectedUnits.length > 0
            ? `${unitGroupLabel(state, selectedIds)} selected — click a highlighted neighbour.`
            : queuedCount > 0
              ? `${queuedCount} order${queuedCount === 1 ? "" : "s"} queued. Submit when ready.`
              : "Click one of your hexes, choose pieces from the hex panel, then click a highlighted neighbour.";

  const locked = submitted || state.phase === "battle";

  return (
    <div className="stack">
      <SectionHeading eyebrow={`Online match · ${match.code}`} title="Play">
        <div className="heading-actions">
          <Tag tone={me === "a" ? "team-a" : "team-b"}>
            You are {PLAYER_LABEL[me]}
          </Tag>
          <Tag>{me === "a" ? "top edge" : "bottom edge"}</Tag>
        </div>
      </SectionHeading>

      <div className="play-layout has-inspector">
        <aside className="stack play-aside">
          <HexInspector
            state={state}
            tile={inspectedTile}
            viewer={me}
            selectedIds={selectedIds}
            disabled={locked}
            draft={draft}
            builds={builds}
            harvests={harvests}
            onToggleGroup={toggleSelection}
            onBuild={addBuild}
          />
        </aside>

        <section className="panel play-board-panel">
          <header className="play-status">
            <div>
              <span className="eyebrow">
                Round {state.turn} ·{" "}
                {state.phase === "battle" ? "battle phase" : "simultaneous"}
              </span>
              <h3 className={`play-owner owner-${me}`}>
                {state.phase === "battle"
                  ? "Resolve the conflict"
                  : submitted
                    ? "Orders locked"
                    : "Plan your moves"}
              </h3>
              <p className="muted small">{status}</p>
            </div>
            <div className="play-status-tags">
              <Tag tone={me === "a" ? "team-a" : "team-b"}>
                {state.phase === "battle"
                  ? "battle phase"
                  : submitted
                    ? "you submitted"
                    : "you are planning"}
              </Tag>
              {opponentReady && !submitted && state.phase !== "battle" && (
                <Tag tone={opponent === "a" ? "team-a" : "team-b"}>
                  {PLAYER_LABEL[opponent]} submitted
                </Tag>
              )}
            </div>
          </header>

          <BattlePanel
            state={state}
            viewer={me}
            canResolve={canResolve}
            onResolve={onResolveBattles}
          />

          {pendingGather && (
            <GatherPrompt
              state={state}
              player={me}
              pending={pendingGather}
              onChoose={chooseGather}
              onCancel={() => setPendingGather(null)}
            />
          )}

          {pendingMove && (
            <MoveCountPrompt
              stacks={pendingMove.stacks}
              destination={tileLabel(pendingMove.col, pendingMove.row)}
              onConfirm={confirmMoveCount}
              onCancel={() => setPendingMove(null)}
            />
          )}

          <StarterBoard
            state={state}
            selectedIds={selectedIds}
            inspectedId={inspectedId}
            onTileClick={onTileClick}
            draft={draft}
            builds={builds}
            disabled={locked}
            canReach={(unit, col, row) => canUnitMoveTo(state, unit, col, row)}
          />

          <div className="play-actions">
            <span className="muted small">
              {state.phase === "battle"
                ? canResolve
                  ? "The battle phase pauses the round until every conflict is resolved."
                  : "The host will resolve the battles, then the next round begins."
                : queuedCount > 0
                  ? `${queuedCount} order${queuedCount === 1 ? "" : "s"} queued. Workers harvest when both players submit.`
                  : "Select one or more pieces on a hex, march them together, then submit. Stacks ask how many march; Workers harvest when the round resolves."}
            </span>
            <div className="play-action-buttons">
              <button className="btn danger" type="button" onClick={forfeit}>
                Forfeit
              </button>
              <button
                className="btn primary"
                type="button"
                onClick={submit}
                disabled={locked}
              >
                {submitted ? "Submitted" : "Submit"}
              </button>
            </div>
          </div>
        </section>

        <aside className="stack play-aside">
          <PlayStocks state={state} />
          <section className="panel">
            <div className="panel-head">
              <h3>Orders</h3>
              <span className="muted small">{queuedCount} queued</span>
            </div>
            {queuedCount === 0 ? (
              <p className="muted small">
                No orders queued. You can submit to hold position.
              </p>
            ) : (
              <ul className="play-orders">
                {orders.map(({ move, unit }) => {
                  const gather = harvests.find(
                    (choice) => choice.unitId === unit.id,
                  )?.gatherFrom;
                  const gatherLabel =
                    unit.typeId === "worker" && gather
                      ? ` · gathers ${gather === "base" ? "◆ Base" : "▲ Refinery"}`
                      : "";
                  return (
                    <li key={unit.id} className={`play-order owner-${unit.owner}`}>
                      <span className="play-order-move">
                        <strong>{UNIT_LABEL[unit.typeId]}</strong>{" "}
                        {tileLabel(unit.col, unit.row)} →{" "}
                        {tileLabel(move.col, move.row)}
                        {gatherLabel}
                      </span>
                      <button
                        className="play-order-remove"
                        type="button"
                        onClick={() => removeOrder(unit.id)}
                        disabled={submitted}
                        aria-label={`Remove order for ${UNIT_LABEL[unit.typeId]} at ${tileLabel(unit.col, unit.row)}`}
                      >
                        ×
                      </button>
                    </li>
                  );
                })}
                {buildOrders.map(({ order, unit }) => (
                  <li key={`build-${unit.id}`} className={`play-order owner-${unit.owner}`}>
                    <span className="play-order-move">
                      <strong>{UNIT_LABEL[unit.typeId]}</strong>{" "}
                      {tileLabel(unit.col, unit.row)} ⚒ {UNIT_LABEL[order.typeId]}
                    </span>
                    <button
                      className="play-order-remove"
                      type="button"
                      onClick={() => removeBuild(unit.id)}
                      disabled={submitted}
                      aria-label={`Remove build order for ${UNIT_LABEL[unit.typeId]} at ${tileLabel(unit.col, unit.row)}`}
                    >
                      ×
                    </button>
                  </li>
                ))}
                {harvestOrders.map(({ choice, unit }) => (
                  <li key={`harvest-${unit.id}`} className={`play-order owner-${unit.owner}`}>
                    <span className="play-order-move">
                      <strong>{UNIT_LABEL[unit.typeId]}</strong>{" "}
                      {tileLabel(unit.col, unit.row)} · gathers{" "}
                      {choice.gatherFrom === "base" ? "◆ Base" : "▲ Refinery"}
                    </span>
                    <button
                      className="play-order-remove"
                      type="button"
                      onClick={() => removeHarvest(unit.id)}
                      disabled={submitted}
                      aria-label={`Remove harvest choice for ${UNIT_LABEL[unit.typeId]} at ${tileLabel(unit.col, unit.row)}`}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <PlayLog state={state} />
          <BattleReports state={state} />
          <section className="panel">
            <div className="panel-head">
              <h3>Online match</h3>
              <span className="muted small">code {match.code}</span>
            </div>
            <ul className="play-help">
              <li>Both players plan at the same time.</li>
              <li>
                Click one of your hexes to inspect it. The hex panel lists every
                piece stacked there; identical pieces share a row such as
                "Soldier x3" or "Worker (Base) x3", and clicking the row selects
                them all.
              </li>
              <li>
                Choose one or more Workers or Soldiers in the panel, then click a
                highlighted adjacent hex. The whole group marches together.
              </li>
              <li>
                Select a single Worker to open the build window for its hex:
                Refinery, Barracks and Factory unlock as you own their
                prerequisites. Select a Base to train a Worker, or a Barracks
                to train a Soldier. Building spends that piece's action for the
                round.
              </li>
              <li>
                Any number of allied pieces can share a hex. Moving into an allied
                hex merges the armies, and two allied groups can meet on the same
                empty hex.
              </li>
              <li>
                An enemy-held hex is a valid destination. If the enemy leaves, you
                move in; if the enemy stays, the border turns red and the battle
                phase resolves the conflict.
              </li>
              <li>
                A hex shows a dot in its owner's colour instead of every piece,
                so inspect your stacks to see what is inside.
              </li>
              <li>
                Workers gather from your Base (◆ minerals) or Refinery (▲ gas)
                on their hex. The structure must stand on a matching node: a Base
                turns up to five assigned Workers into minerals, a Refinery up
                to three into gas. If both stand there, choose when you move in;
                to change the choice click the Worker, then click its own hex.
              </li>
              <li>
                Submit your orders. When both players have submitted, every army
                moves at once, conflicts are fought, and Workers harvest.
              </li>
              <li>
                The host resolves the battle phase; the guest sees the conflict
                borders and waits for the result.
              </li>
              <li>
                Forfeit declares {PLAYER_LABEL[opponent]} the winner and returns
                both players to the matching screen.
              </li>
              <li>
                Losing your last structure eliminates you and the other player
                wins. If both sides lose their last structure in the same round,
                the game is a draw.
              </li>
              <li>If the connection drops, the tab returns to matchmaking.</li>
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}

function StarterBoard({
  state,
  selectedIds,
  inspectedId = null,
  onTileClick,
  canReach,
  draft = [],
  builds = [],
  disabled = false,
}: {
  state: PlayState;
  selectedIds: string[];
  inspectedId?: string | null;
  onTileClick: (tile: MapTile) => void;
  canReach: (unit: PlayUnit, col: number, row: number) => boolean;
  draft?: PlayMove[];
  builds?: BuildOrder[];
  disabled?: boolean;
}) {
  const selectedUnits = selectedIds
    .map((id) => unitById(state, id))
    .filter((unit): unit is PlayUnit => unit !== undefined);
  const selectedOwner = selectedUnits[0]?.owner;

  return (
    <div className="hex-board-wrap">
      <div
        className="hex-board"
        style={{
          width: BOARD_W,
          height: BOARD_H,
          ["--hex-w" as string]: `${HEX_W}px`,
          ["--hex-h" as string]: `${HEX_H}px`,
        }}
      >
        {MAP_TILES.map((tile) => {
          const occupants = unitsAt(state, tile.col, tile.row);
          const owner = occupants[0]?.owner;
          const movable =
            !disabled &&
            selectedUnits.length > 0 &&
            selectedUnits.every((unit) => canReach(unit, tile.col, tile.row));
          const attack =
            movable &&
            selectedOwner !== undefined &&
            occupants.some((unit) => unit.owner !== selectedOwner);
          const isSelected = occupants.some((unit) => selectedIds.includes(unit.id));
          const draftMoves = draft.filter(
            (move) => move.col === tile.col && move.row === tile.row,
          );
          const draftUnit =
            draftMoves[0] !== undefined
              ? unitById(state, draftMoves[0].unitId)
              : undefined;
          const conflictTarget = state.conflicts.some(
            (conflict) =>
              conflict.target.col === tile.col && conflict.target.row === tile.row,
          );
          const conflictSource = state.conflicts.some((conflict) =>
            conflict.attacks.some(
              (entry) => entry.from.col === tile.col && entry.from.row === tile.row,
            ),
          );
          const allQueued =
            occupants.length > 0 &&
            occupants.every((unit) =>
              draft.some((move) => move.unitId === unit.id),
            );
          const buildHere = builds.filter((order) => {
            const builder = unitById(state, order.builderId);
            return builder?.col === tile.col && builder.row === tile.row;
          }).length;
          const classes = [
            "hex-tile",
            tile.resources.length > 0
              ? `has-resource ${tile.resources.map((resource) => `resource-${resource}`).join(" ")}`
              : "",
            movable ? "is-move" : "",
            attack ? "is-attack" : "",
            isSelected ? "is-selected" : "",
            inspectedId === tile.id ? "is-inspected" : "",
            owner ? `has-unit owner-${owner}` : "",
            draftMoves.length > 0 ? "is-draft-target" : "",
            allQueued ? "is-draft-source" : "",
            buildHere > 0 ? "is-build-target" : "",
            conflictTarget ? "is-conflict" : "",
            conflictSource ? "is-conflict-source" : "",
            disabled ? "is-locked" : "",
          ]
            .filter(Boolean)
            .join(" ");

          return (
            <button
              type="button"
              key={tile.id}
              className={classes}
              style={{
                left: tile.col * HEX_W + (tile.row % 2 === 1 ? HEX_W / 2 : 0),
                top: tile.row * ROW_STEP,
              }}
              onClick={() => onTileClick(tile)}
              aria-label={`${tileLabel(tile.col, tile.row)}${
                tile.resources.length > 0
                  ? `, ${tile.resources.join(" and ")} node`
                  : ""
              }${owner ? `, occupied by ${PLAYER_LABEL[owner]}` : ""}${
                draftMoves.length > 0 ? ", queued move here" : ""
              }${buildHere > 0 ? ", construction queued here" : ""}${
                conflictTarget ? ", conflict" : ""
              }`}
            >
              <span className="hex-face">
                {tile.resources.length > 0 && (
                  <span className="hex-resources" aria-hidden="true">
                    {tile.resources.map((resource) => (
                      <span key={resource} className={`hex-resource ${resource}`}>
                        {RESOURCE_GLYPH[resource]}
                      </span>
                    ))}
                  </span>
                )}
                {owner && (
                  <span
                    className={`hex-occupant-dot owner-${owner}${allQueued ? " is-queued" : ""}`}
                    aria-hidden="true"
                  />
                )}
                {conflictTarget && (
                  <span className="hex-conflict-badge" aria-hidden="true">
                    ⚔
                  </span>
                )}
                {draftMoves.length > 0 && draftUnit && (
                  <span
                    className={`hex-draft-marker owner-${draftUnit.owner}`}
                    aria-hidden="true"
                  >
                    →{draftMoves.length > 1 ? draftMoves.length : ""}
                  </span>
                )}
                {buildHere > 0 && (
                  <span className="hex-build-marker" aria-hidden="true">
                    ⚒{buildHere > 1 ? buildHere : ""}
                  </span>
                )}
                <span className="hex-coord" aria-hidden="true">
                  {tileLabel(tile.col, tile.row)}
                </span>
              </span>
            </button>
          );
        })}
        <ConflictOverlay conflicts={state.conflicts} />
      </div>
    </div>
  );
}

function ConflictOverlay({ conflicts }: { conflicts: Conflict[] }) {
  if (conflicts.length === 0) return null;

  return (
    <svg
      className="hex-conflict-layer"
      width={BOARD_W}
      height={BOARD_H}
      viewBox={`0 0 ${BOARD_W} ${BOARD_H}`}
      aria-hidden="true"
    >
      {conflicts.flatMap((conflict) =>
        conflict.attacks.map((attack) => {
          const from = hexCenter(attack.from.col, attack.from.row);
          const to = hexCenter(conflict.target.col, conflict.target.row);
          return (
            <g key={`${conflict.id}-${attack.from.col}-${attack.from.row}`}>
              <line
                className="hex-conflict-line"
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
              />
              <circle
                className="hex-conflict-node"
                cx={to.x}
                cy={to.y}
                r={7}
              />
            </g>
          );
        }),
      )}
    </svg>
  );
}

function BattlePanel({
  state,
  viewer,
  canResolve,
  onResolve,
}: {
  state: PlayState;
  viewer: Player;
  canResolve: boolean;
  onResolve: () => void;
}) {
  if (state.phase !== "battle" || state.conflicts.length === 0) return null;

  return (
    <section className="panel battle-panel">
      <div className="panel-head">
        <h3>Battle phase</h3>
        <span className="muted small">
          {state.conflicts.length} conflict{state.conflicts.length === 1 ? "" : "s"}
        </span>
      </div>
      <p className="muted small">
        Armies that entered an occupied hex were held at the border. The battle
        phase fights each contested hex before the round can end.
      </p>
      <ul className="battle-conflicts">
        {state.conflicts.map((conflict) => {
          const defenderUnits = unitsAt(
            state,
            conflict.target.col,
            conflict.target.row,
          ).filter((unit) => unit.owner === conflict.defender);

          return (
            <li
              key={conflict.id}
              className={`battle-conflict owner-${conflict.defender}`}
            >
              <div className="battle-conflict-head">
                <strong>⚔ {tileLabel(conflict.target.col, conflict.target.row)}</strong>
                <span className="battle-role">
                  {conflict.defender === viewer ? "you defend" : "you attack"}
                </span>
                <span className="muted small">
                  {PLAYER_LABEL[conflict.defender]} defends
                </span>
              </div>
              <div className="battle-sides">
                <span>
                  <b>{PLAYER_LABEL[conflict.defender]}</b>:{" "}
                  {unitGroupLabel(state, defenderUnits.map((unit) => unit.id))}
                </span>
                {conflict.attacks.map((attack) => (
                  <span key={`${attack.from.col},${attack.from.row}`}>
                    <b>{PLAYER_LABEL[attack.player]}</b> from{" "}
                    {tileLabel(attack.from.col, attack.from.row)}:{" "}
                    {unitGroupLabel(state, attack.unitIds)}
                  </span>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
      {canResolve ? (
        <button className="btn primary" type="button" onClick={onResolve}>
          Resolve battles
        </button>
      ) : (
        <p className="battle-waiting">
          Waiting for the host to resolve the battles…
        </p>
      )}
    </section>
  );
}

function BattleReports({ state }: { state: PlayState }) {
  if (state.battles.length === 0) return null;

  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Battle reports</h3>
        <span className="muted small">last battles</span>
      </div>
      <ul className="battle-reports">
        {state.battles.map((report) => (
          <BattleReportCard key={report.conflictId} report={report} />
        ))}
      </ul>
    </section>
  );
}

function BattleReportCard({ report }: { report: BattleReport }) {
  return (
    <li className="battle-report">
      <div className="battle-report-head">
        <strong>{tileLabel(report.target.col, report.target.row)}</strong>
        <span className={`battle-verdict verdict-${report.winner}`}>
          {report.winner === "draw"
            ? "Draw"
            : `${PLAYER_LABEL[report.winner]} wins`}
        </span>
      </div>
      <p className="battle-report-reason">{report.reason}</p>
      <div className="battle-report-sides">
        <span className={`owner-${report.attacker}`}>
          {PLAYER_LABEL[report.attacker]}:{" "}
          {report.survivors[report.attacker].length}/
          {report.startingUnits[report.attacker]} survive
        </span>
        <span className={`owner-${report.defender}`}>
          {PLAYER_LABEL[report.defender]}:{" "}
          {report.survivors[report.defender].length}/
          {report.startingUnits[report.defender]} survive
        </span>
      </div>
      <p className="battle-report-outcome">
        {report.occupied
          ? `${PLAYER_LABEL[report.attacker]} took the hex.`
          : report.winner === "draw"
            ? "The hex remains contested."
            : `${PLAYER_LABEL[report.defender]} held the hex.`}
      </p>
    </li>
  );
}

function BuildWindow({
  builder,
  options,
  queued,
  onBuild,
}: {
  builder: PlayUnit;
  options: BuildOption[];
  queued: BuildOrder | undefined;
  onBuild: (typeId: PlayUnitType) => void;
}) {
  const trains = builder.typeId === "base" || builder.typeId === "barracks";
  return (
    <div className="play-build">
      <div className="play-build-head">
        <h4>{trains ? "Train here" : "Build here"}</h4>
        <span className="muted small">
          {tileLabel(builder.col, builder.row)}
        </span>
      </div>
      <p className="muted small">
        {builder.typeId === "base"
          ? "The Base spends its action to train a Worker on this hex."
          : builder.typeId === "barracks"
            ? "The Barracks spends its action to train a Soldier on this hex."
            : "The Worker spends its action to construct a structure on this hex."}
      </p>
      <ul className="play-build-list">
        {options.map((option) => {
          const disabled = queued !== undefined || !option.enabled;
          const reason =
            queued !== undefined
              ? `Queued: ${UNIT_LABEL[queued.typeId]}`
              : option.reason;
          return (
            <li key={option.typeId}>
              <button
                className="play-build-option"
                type="button"
                onClick={() => onBuild(option.typeId)}
                disabled={disabled}
              >
                <span
                  className="play-build-glyph"
                  style={{ color: typeColor(option.typeId) }}
                  aria-hidden="true"
                >
                  {option.glyph}
                </span>
                <span className="play-build-body">
                  <span className="play-build-name">
                    <strong>{option.name}</strong>
                    <span className="play-build-cost">
                      {describeCost(option.cost)}
                    </span>
                  </span>
                  <span className="play-build-note">
                    {reason ??
                      `Supply ${option.supplyUsed}/${option.supplyMax}`}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function GatherPrompt({
  state,
  player,
  pending,
  onChoose,
  onCancel,
}: {
  state: PlayState;
  player: Player;
  pending: PendingGather;
  onChoose: (gatherFrom: GatherFrom) => void;
  onCancel: () => void;
}) {
  const options = gatherOptionsAt(state, player, pending.col, pending.row);
  const unit = unitById(state, pending.unitIds[0] ?? "");
  const current: GatherFrom = pending.move
    ? "base"
    : unit?.gatherFrom ?? "base";

  return (
    <section className="play-gather" aria-label="Choose a structure to gather from">
      <div className="panel-head">
        <h3>{pending.move ? "Gather from" : "Change harvest"}</h3>
        <span className="muted small">
          {tileLabel(pending.col, pending.row)}
        </span>
      </div>
      <p className="muted small">
        This hex holds both a Base and a Refinery. Pick the structure this
        Worker is assigned to for the end of the round. A Base turns up to five
        assigned Workers into minerals; a Refinery turns up to three into gas.
      </p>
      <div className="play-gather-buttons">
        {options.map((option) => (
          <button
            key={option}
            className={`btn${!pending.move && current === option ? " primary" : ""}`}
            type="button"
            onClick={() => onChoose(option)}
          >
            {option === "base"
              ? "Base · up to 5 ◆ minerals"
              : "Refinery · up to 3 ▲ gas"}
          </button>
        ))}
        <button className="btn ghost" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}

function MoveCountPrompt({
  stacks,
  destination,
  onConfirm,
  onCancel,
}: {
  stacks: UnitStack[];
  destination: string;
  onConfirm: (counts: number[]) => void;
  onCancel: () => void;
}) {
  const [counts, setCounts] = useState<number[]>(() =>
    stacks.map((stack) => stack.units.length),
  );
  const total = counts.reduce((sum, count) => sum + count, 0);

  const setCount = (index: number, next: number) => {
    const stack = stacks[index];
    if (!stack) return;
    const clamped = Math.max(0, Math.min(stack.units.length, next));
    setCounts((current) =>
      current.map((count, position) =>
        position === index ? clamped : count,
      ),
    );
  };

  return (
    <section className="play-gather" aria-label="Choose how many pieces move">
      <div className="panel-head">
        <h3>How many move?</h3>
        <span className="muted small">{destination}</span>
      </div>
      <p className="muted small">
        Choose how many of each stack march to {destination}. The rest hold this
        hex.
      </p>
      <ul className="play-move-count-list">
        {stacks.map((stack, index) => {
          const count = counts[index] ?? stack.units.length;
          return (
            <li key={`${stack.typeId}:${stack.assignment ?? index}`}>
              <span className="play-move-count-label">
                {stackLabel(
                  stack.typeId,
                  stack.assignment,
                  stack.units.length,
                )}
              </span>
              <span className="play-move-count-stepper">
                <button
                  className="btn ghost"
                  type="button"
                  onClick={() => setCount(index, count - 1)}
                  disabled={count <= 0}
                  aria-label={`Move one fewer ${UNIT_LABEL[stack.typeId]}`}
                >
                  −
                </button>
                <strong>{count}</strong>
                <button
                  className="btn ghost"
                  type="button"
                  onClick={() => setCount(index, count + 1)}
                  disabled={count >= stack.units.length}
                  aria-label={`Move one more ${UNIT_LABEL[stack.typeId]}`}
                >
                  +
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      <div className="play-gather-buttons">
        <button
          className="btn primary"
          type="button"
          onClick={() => onConfirm(counts)}
          disabled={total === 0}
        >
          Move {total}
        </button>
        <button className="btn ghost" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}

function HexInspector({
  state,
  tile,
  viewer,
  selectedIds,
  onToggleGroup,
  draft = [],
  builds = [],
  harvests = [],
  onBuild,
  disabled = false,
}: {
  state: PlayState;
  tile: MapTile | undefined;
  viewer: Player;
  selectedIds: string[];
  onToggleGroup: (unitIds: string[]) => void;
  draft?: PlayMove[];
  builds?: BuildOrder[];
  harvests?: HarvestChoice[];
  onBuild?: (builderId: string, typeId: PlayUnitType) => void;
  disabled?: boolean;
}) {
  const occupants = tile ? unitsAt(state, tile.col, tile.row) : [];
  const owner = occupants[0]?.owner;
  const enemy = owner !== undefined && owner !== viewer;
  const conflictHere =
    tile !== undefined &&
    state.conflicts.some(
      (conflict) =>
        conflict.target.col === tile.col && conflict.target.row === tile.row,
    );
  const revealEnemy = enemy && state.phase === "battle" && conflictHere;
  const canAct = (unit: PlayUnit) =>
    owner === viewer &&
    !disabled &&
    !unit.moved &&
    !draft.some((move) => move.unitId === unit.id) &&
    !builds.some((order) => order.builderId === unit.id) &&
    (getDefinition(unit.typeId).kind !== "structure" ||
      buildOptions(state, viewer, unit.id).length > 0);
  const hasSelectable = occupants.some(canAct);
  const selectedPieces = selectedIds
    .map((id) => unitById(state, id))
    .filter((unit): unit is PlayUnit => unit !== undefined);
  const builder = selectedPieces.find(
    (unit) =>
      unit.owner === viewer &&
      canAct(unit) &&
      buildOptions(state, viewer, unit.id).length > 0,
  );
  const options = builder ? buildOptions(state, viewer, builder.id) : [];
  const queuedBuild = builder
    ? builds.find((order) => order.builderId === builder.id)
    : undefined;
  const selectedWorker =
    selectedPieces.length === 1 && selectedPieces[0]?.typeId === "worker"
      ? selectedPieces[0]
      : undefined;
  const selectedDual =
    selectedWorker !== undefined &&
    tile !== undefined &&
    selectedWorker.col === tile.col &&
    selectedWorker.row === tile.row &&
    gatherOptionsAt(state, viewer, tile.col, tile.row).length > 1;

  const stacks = buildStacks(state, occupants, draft, builds, harvests, true);

  return (
    <section className="panel play-inspector">
      <div className="panel-head">
        <h3>{tile ? `Hex ${tileLabel(tile.col, tile.row)}` : "Hex contents"}</h3>
      </div>

      {!tile ? (
        <p className="muted small">
          Click a hex to inspect it. Identical pieces share one stacked row, and
          clicking that row selects the whole stack.
        </p>
      ) : enemy && !revealEnemy ? (
        <p className="play-inspector-enemy">Occupied by enemy</p>
      ) : occupants.length === 0 ? (
        <p className="muted small">
          Empty hex
          {tile.resources.length > 0
            ? ` with ${tile.resources.join(" and ")} nodes`
            : ""}
          .
        </p>
      ) : (
        <>
          <p className="muted small">
            {occupants.length} piece{occupants.length === 1 ? "" : "s"} ·{" "}
            {PLAYER_LABEL[owner ?? viewer]}
            {revealEnemy ? " · revealed by conflict" : ""}
          </p>
          <ul className="play-inspector-list">
            {stacks.map((stack) => {
              const isStructure =
                getDefinition(stack.typeId).kind === "structure";
              const selectableIds = stack.units
                .filter(canAct)
                .map((unit) => unit.id);
              const selected =
                selectableIds.length > 0 &&
                selectableIds.every((id) => selectedIds.includes(id));
              const moveOrders = stack.units
                .map((unit) => draft.find((move) => move.unitId === unit.id))
                .filter((move): move is PlayMove => move !== undefined);
              const building = stack.units
                .map((unit) =>
                  builds.find((entry) => entry.builderId === unit.id),
                )
                .filter((entry): entry is BuildOrder => entry !== undefined);
              const note = (() => {
                if (building.length > 0) {
                  const names = [
                    ...new Set(
                      building.map((entry) => UNIT_LABEL[entry.typeId]),
                    ),
                  ];
                  return `Building ${names.join(" + ")}`;
                }
                if (isStructure) {
                  if (stack.typeId === "base") {
                    return "Structure · cannot move · trains Workers";
                  }
                  if (stack.typeId === "barracks") {
                    return "Structure · cannot move · trains Soldiers";
                  }
                  return "Structure · cannot move";
                }
                if (moveOrders.length > 0) {
                  const destinations = new Set(
                    moveOrders.map((move) => tileLabel(move.col, move.row)),
                  );
                  if (
                    moveOrders.length === stack.units.length &&
                    destinations.size === 1
                  ) {
                    return `Queued → ${[...destinations][0]}`;
                  }
                  return `${moveOrders.length} queued`;
                }
                const ready = stack.units.filter((unit) => !unit.moved).length;
                if (ready === stack.units.length) return "Ready to move";
                if (ready === 0) return "Already acted";
                return `${ready} ready · ${stack.units.length - ready} acted`;
              })();
              const hpValues = stack.units.map(unitHp);
              const maxHp = getDefinition(stack.typeId).hp;
              const damaged = hpValues.some((hp) => hp < maxHp);
              const lowHp = Math.min(...hpValues);
              const highHp = Math.max(...hpValues);
              const hpNote = damaged
                ? lowHp === highHp
                  ? ` · ${lowHp}/${maxHp} HP`
                  : ` · ${lowHp}–${highHp}/${maxHp} HP`
                : "";
              return (
                <li
                  key={`${stack.typeId}:${stack.assignment ?? stack.units[0]?.id}`}
                >
                  <button
                    type="button"
                    className={`play-piece${selected ? " is-selected" : ""}`}
                    onClick={() => onToggleGroup(selectableIds)}
                    disabled={selectableIds.length === 0}
                  >
                    <span
                      className="play-piece-glyph"
                      style={{ color: typeColor(stack.typeId) }}
                      aria-hidden="true"
                    >
                      {getDefinition(stack.typeId).glyph}
                    </span>
                    <span className="play-piece-body">
                      <strong className="play-piece-name">
                        {stackLabel(
                          stack.typeId,
                          stack.assignment,
                          stack.units.length,
                          stack.status,
                        )}
                      </strong>
                      <span className="play-piece-note">
                        {note}
                        {hpNote}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {builder && options.length > 0 && (
            <BuildWindow
              builder={builder}
              options={options}
              queued={queuedBuild}
              onBuild={(typeId) => onBuild?.(builder.id, typeId)}
            />
          )}
          {owner === viewer && hasSelectable && (
            <p className="muted small">
              {selectedDual
                ? "Click this hex again to switch which structure this Worker gathers from."
                : selectedIds.length > 0
                  ? `${selectedIds.length} selected. Click a highlighted neighbour to march the group together.`
                  : "Select one or more pieces, then click a highlighted neighbouring hex. Select a Worker or a stack to build, or a Base/Barracks to train."}
            </p>
          )}
          {revealEnemy && (
            <p className="muted small">
              The conflict reveals the defending garrison.
            </p>
          )}
        </>
      )}
    </section>
  );
}

function PlayStocks({ state }: { state: PlayState }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Resources</h3>
        <span className="muted small">harvested</span>
      </div>
      <div className="play-stock-grid">
        {(["a", "b"] as Player[]).map((player) => (
          <div key={player} className={`play-stock owner-${player}`}>
            <span className="eyebrow">{PLAYER_LABEL[player]}</span>
            <div className="play-stock-row">
              <span className="play-stock-symbol minerals" aria-hidden="true">
                ◆
              </span>
              <span className="play-stock-value">{state.stock[player].minerals}</span>
              <span className="play-stock-label">minerals</span>
            </div>
            <div className="play-stock-row">
              <span className="play-stock-symbol gas" aria-hidden="true">
                ▲
              </span>
              <span className="play-stock-value">{state.stock[player].gas}</span>
              <span className="play-stock-label">gas</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function PlayLog({ state }: { state: PlayState }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Log</h3>
        <span className="muted small">last moves</span>
      </div>
      <ol className="play-log">
        {state.log
          .slice()
          .reverse()
          .map((line, index) => (
            <li key={`${line}-${index}`}>{line}</li>
          ))}
      </ol>
    </section>
  );
}

function PracticePlay({ onBack }: { onBack: () => void }) {
  const [mode, setMode] = useState<PlayMode>("starter");
  const modes: { id: PlayMode; label: string }[] = [
    { id: "starter", label: "Starter Skirmish" },
    { id: "amazons", label: "Amazons" },
    { id: "pferdeaeppel", label: "Pferdeäppel" },
  ];

  return (
    <div className="stack">
      <div className="practice-bar">
        <span className="eyebrow">Practice locally</span>
        <button className="btn ghost" type="button" onClick={onBack}>
          Back to matchmaking
        </button>
      </div>
      <nav className="variant-tabs" aria-label="Choose a game variant">
        {modes.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`variant-tab${mode === entry.id ? " is-active" : ""}`}
            aria-pressed={mode === entry.id}
            onClick={() => setMode(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </nav>
      {mode === "starter" ? <StarterPlay /> : <ChessVariants variant={mode} />}
    </div>
  );
}

function StarterPlay() {
  const [storedState, setState] = useLocalStorage<PlayState>(
    "mbg.play.state",
    createInitialState(),
  );
  const state = normalizePlayState(storedState);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const [pendingGather, setPendingGather] = useState<PendingGather | null>(null);
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);

  const selectedUnits = selectedIds
    .map((id) => unitById(state, id))
    .filter((unit): unit is PlayUnit => unit !== undefined);
  const inspectedTile = inspectedId
    ? MAP_TILES.find((tile) => tile.id === inspectedId)
    : undefined;
  const income = harvestFor(state, state.active);
  const readyUnits = state.units.filter(
    (unit) => unit.owner === state.active && !unit.moved,
  ).length;

  useEffect(() => {
    setSelectedIds([]);
    setPendingGather(null);
    setPendingMove(null);
  }, [state.active]);

  const reset = () => {
    setState(createInitialState());
    setSelectedIds([]);
    setInspectedId(null);
    setPendingGather(null);
    setPendingMove(null);
  };

  const toggleSelection = (unitIds: string[]) => {
    setSelectedIds((current) => toggleSelectedIds(state, current, unitIds));
  };

  const onBuild = (builderId: string, typeId: PlayUnitType) => {
    const next = buildUnit(state, state.active, builderId, typeId);
    if (next !== state) {
      setState(next);
      // Keep any other selected Workers so the next one can build too.
      setSelectedIds((current) => current.filter((id) => id !== builderId));
    }
  };

  const chooseGather = (gatherFrom: GatherFrom) => {
    const pending = pendingGather;
    if (!pending) return;

    if (pending.move) {
      const next = moveUnits(
        state,
        pending.unitIds,
        pending.col,
        pending.row,
        gatherFrom,
      );
      if (next !== state) {
        setState(next);
        setSelectedIds([]);
        setInspectedId(pending.tileId);
      }
    } else {
      const unitId = pending.unitIds[0];
      if (unitId) {
        const next = setGatherPreference(
          state,
          state.active,
          unitId,
          gatherFrom,
        );
        if (next !== state) {
          setState(next);
          setInspectedId(pending.tileId);
        }
      }
    }
    setPendingGather(null);
  };

  /** Move the group now, asking for a gather assignment when the hex offers both. */
  const beginMove = (tile: MapTile, unitIds: string[]) => {
    if (unitIds.length === 0) return;
    const hasWorker = unitIds.some(
      (id) => unitById(state, id)?.typeId === "worker",
    );
    const gatherOptions = gatherOptionsAt(
      state,
      state.active,
      tile.col,
      tile.row,
    );
    if (hasWorker && gatherOptions.length > 1) {
      setPendingGather({
        unitIds,
        col: tile.col,
        row: tile.row,
        tileId: tile.id,
        move: true,
      });
      setInspectedId(tile.id);
      return;
    }

    const next = moveUnits(state, unitIds, tile.col, tile.row);
    if (next !== state) {
      setState(next);
      setSelectedIds([]);
      setInspectedId(tile.id);
    }
  };

  const confirmMoveCount = (counts: number[]) => {
    const pending = pendingMove;
    if (!pending) return;
    const unitIds = pending.stacks.flatMap((stack, index) =>
      stack.units
        .slice(0, counts[index] ?? stack.units.length)
        .map((unit) => unit.id),
    );
    setPendingMove(null);
    const tile = MAP_TILES.find((entry) => entry.id === pending.tileId);
    if (tile) beginMove(tile, unitIds);
  };

  const onTileClick = (tile: MapTile) => {
    if (state.winner) return;
    if (state.phase === "battle") {
      setInspectedId(tile.id);
      return;
    }

    const group = selectedUnits;
    const onlyUnit = group.length === 1 ? group[0] : undefined;

    // Clicking a selected Worker's own dual hex re-picks its structure.
    if (
      onlyUnit &&
      onlyUnit.typeId === "worker" &&
      onlyUnit.col === tile.col &&
      onlyUnit.row === tile.row &&
      gatherOptionsAt(state, state.active, tile.col, tile.row).length > 1
    ) {
      setPendingGather({
        unitIds: [onlyUnit.id],
        col: tile.col,
        row: tile.row,
        tileId: tile.id,
        move: false,
      });
      setInspectedId(tile.id);
      return;
    }

    const canGroupMove =
      group.length > 0 &&
      group.every((unit) => canMoveTo(state, unit, tile.col, tile.row));

    if (canGroupMove) {
      const stacks = movementStacks(state, group, [], []);
      if (stacks.some((stack) => stack.units.length > 1)) {
        setPendingMove({
          tileId: tile.id,
          col: tile.col,
          row: tile.row,
          stacks,
        });
        setInspectedId(tile.id);
        return;
      }
      beginMove(
        tile,
        group.map((unit) => unit.id),
      );
      return;
    }

    setInspectedId(tile.id);
  };

  const finishTurn = () => {
    setState(endTurn(state));
    setSelectedIds([]);
  };

  const resolveBattlePhase = () => {
    setState(resolveBattles(state));
    setSelectedIds([]);
  };

  const gameOver = Boolean(state.winner);
  const status = state.winner
    ? state.winner === "draw"
      ? "Draw — both sides lost all their structures. Reset the map to play again."
      : `${PLAYER_LABEL[state.winner]} wins — ${PLAYER_LABEL[otherPlayer(state.winner)]} was eliminated. Reset the map to play again.`
    : state.phase === "battle"
      ? "Battle phase — resolve the conflicts before the turn can end."
      : selectedUnits.length > 0
        ? `${unitGroupLabel(state, selectedIds)} selected — click a highlighted neighbour.`
        : readyUnits > 0
          ? "Click one of your hexes, then choose one or more pieces from the hex panel."
          : "Every piece has acted. End the turn to harvest and pass play.";

  return (
    <div className="stack">
      <SectionHeading eyebrow="Starter skirmish" title="Play">
        <div className="heading-actions">
          <button className="btn ghost" onClick={reset}>
            Reset map
          </button>
        </div>
      </SectionHeading>

      {state.winner && (
        <section className={`panel result-panel winner-${state.winner}`}>
          <header className="result-head">
            <div>
              <span className="eyebrow">Game over</span>
              <h3>
                {state.winner === "draw"
                  ? "Draw"
                  : `${PLAYER_LABEL[state.winner]} wins`}
              </h3>
              <p className="muted">
                {state.winner === "draw"
                  ? "Both players lost all their structures."
                  : `${PLAYER_LABEL[otherPlayer(state.winner)]} lost all structures and is eliminated.`}
              </p>
            </div>
            <button className="btn primary" type="button" onClick={reset}>
              Play again
            </button>
          </header>
        </section>
      )}

      <div className="play-layout has-inspector">
        <aside className="stack play-aside">
          <HexInspector
            state={state}
            tile={inspectedTile}
            viewer={state.active}
            selectedIds={selectedIds}
            disabled={gameOver || state.phase === "battle"}
            onToggleGroup={toggleSelection}
            onBuild={onBuild}
          />
        </aside>

        <section className="panel play-board-panel">
          <header className="play-status">
            <div>
              <span className="eyebrow">
                Round {state.turn}
                {state.phase === "battle" ? " · battle phase" : ""}
              </span>
              <h3 className={`play-owner owner-${state.active}`}>
                {state.winner
                  ? state.winner === "draw"
                    ? "Draw"
                    : `${PLAYER_LABEL[state.winner]} wins`
                  : state.phase === "battle"
                    ? "Resolve the conflict"
                    : `${PLAYER_LABEL[state.active]}'s turn`}
              </h3>
              <p className="muted small">{status}</p>
            </div>
            <Tag tone={state.active === "a" ? "team-a" : "team-b"}>
              {state.active === "a" ? "top edge" : "bottom edge"}
            </Tag>
          </header>

          <BattlePanel
            state={state}
            viewer={state.active}
            canResolve
            onResolve={resolveBattlePhase}
          />

          {pendingGather && (
            <GatherPrompt
              state={state}
              player={state.active}
              pending={pendingGather}
              onChoose={chooseGather}
              onCancel={() => setPendingGather(null)}
            />
          )}

          {pendingMove && (
            <MoveCountPrompt
              stacks={pendingMove.stacks}
              destination={tileLabel(pendingMove.col, pendingMove.row)}
              onConfirm={confirmMoveCount}
              onCancel={() => setPendingMove(null)}
            />
          )}

          <StarterBoard
            state={state}
            selectedIds={selectedIds}
            inspectedId={inspectedId}
            onTileClick={onTileClick}
            disabled={gameOver || state.phase === "battle"}
            canReach={(unit, col, row) => canMoveTo(state, unit, col, row)}
          />

          <div className="play-actions">
            <span className="muted small">
              {gameOver ? (
                "The game is over. Reset the map to play again."
              ) : state.phase === "battle" ? (
                "The battle phase must be resolved before the turn can end."
              ) : (
                <>
                  Ending the turn collects <strong>{stockSummary(income)}</strong>.
                </>
              )}
            </span>
            {!gameOver &&
              (state.phase === "battle" ? (
                <button className="btn primary" onClick={resolveBattlePhase}>
                  Resolve battles
                </button>
              ) : (
                <button className="btn primary" onClick={finishTurn}>
                  End {PLAYER_LABEL[state.active]}'s turn
                </button>
              ))}
          </div>
        </section>

        <aside className="stack play-aside">
          <PlayStocks state={state} />
          <PlayLog state={state} />
          <BattleReports state={state} />
          <section className="panel">
            <div className="panel-head">
              <h3>How to play</h3>
            </div>
            <ul className="play-help">
              <li>
                Click one of your hexes to inspect it, then select one or more
                Workers or Soldiers from the hex panel. Identical pieces share a
                stacked row such as "Soldier x3" or "Worker (Base) x3".
              </li>
              <li>
                Click a highlighted neighbouring hex to move the selected
                stacks. When a stack holds more than one piece, a prompt asks
                how many march; the movers show "(moving)" and the rest hold the
                hex. Any number of allied pieces can share a hex.
              </li>
              <li>
                Allied hexes are valid destinations, so armies can merge. Two
                allied groups can also meet on the same empty hex.
              </li>
              <li>
                Enemy-held hexes are valid destinations too. If the enemy stays,
                the border turns red and the battle resolves immediately in
                practice. If the enemy leaves, the hex is yours.
              </li>
              <li>A hex shows a dot in its owner's colour instead of each piece.</li>
              <li>
                Each unit moves once per turn. Structures hold their hex; a
                selected Base trains Workers and a Barracks trains Soldiers. Both
                sides start with three Workers on their Base and no Soldiers, so
                build a Barracks before fielding an army.
              </li>
              <li>
                Select a Worker or a stack of Workers to build a structure on the
                hex. A Base unlocks Refinery and Barracks; a Barracks unlocks the
                Factory. Each builder spends its action and shows "(building)";
                that Worker can neither move nor gather that round.
              </li>
              <li>
                Node hexes sit at the middle of each side. A Base on a mineral
                node turns up to 5 assigned Workers into 5◆; a Refinery on a gas
                node turns up to 3 into 3▲. Extra Workers add nothing, and
                structures off a node produce nothing.
              </li>
              <li>
                If a hex holds both your Base and Refinery, choose the structure
                when the Worker moves in. To change the choice, select the
                Worker and click its own hex — this costs no action.
              </li>
              <li>
                Harvested resources pay for construction and training. Each side
                starts with 4◆.
              </li>
              <li>
                A player loses when their last structure is destroyed. The other
                side wins; if both lose their last structure in the same round,
                the game is a draw.
              </li>
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}
