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
  harvestFor,
  moveUnits,
  normalizePlayState,
  otherPlayer,
  resolveBattles,
  resolveRound,
  tileLabel,
  unitById,
  unitHp,
  unitsAt,
  type BattleReport,
  type BuildOption,
  type BuildOrder,
  type Conflict,
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

/** Selection is limited to pieces standing on one hex so they can march together. */
function toggleSelectedIds(
  state: PlayState,
  current: string[],
  unitId: string,
): string[] {
  const unit = unitById(state, unitId);
  if (!unit) return current;

  const otherHex = current.some((id) => {
    const other = unitById(state, id);
    return other && (other.col !== unit.col || other.row !== unit.row);
  });
  if (otherHex) return [unitId];

  // Structures cannot march, and their window only opens for one piece, so a
  // structure is always selected on its own.
  if (getDefinition(unit.typeId).kind === "structure") {
    return current.includes(unitId) ? [] : [unitId];
  }
  const currentHasStructure = current.some((id) => {
    const other = unitById(state, id);
    return other && getDefinition(other.typeId).kind === "structure";
  });
  if (currentHasStructure) return [unitId];

  return current.includes(unitId)
    ? current.filter((id) => id !== unitId)
    : [...current, unitId];
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
    .map(([name, count]) => `${count} ${name}${count === 1 ? "" : "s"}`)
    .join(" + ");
}

type PlayMode = "starter" | ChessVariantId;

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
    a: { moves: PlayMove[]; builds: BuildOrder[] } | null;
    b: { moves: PlayMove[]; builds: BuildOrder[] } | null;
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

  const submitMoves = (moves: PlayMove[], builds: BuildOrder[]) => {
    const handle = matchRef.current;
    if (!handle) return;

    if (handle.role === "host") {
      pendingRef.current.a = { moves, builds };
      // Let the guest know the host is waiting on them. If the guest submitted
      // first, the round resolves right away instead.
      if (!pendingRef.current.b) handle.send({ kind: "ready", player: "a" });
      resolveIfReady(handle);
      return;
    }

    handle.send({ kind: "action", action: { type: "submit", moves, builds } });
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
  onSubmit: (moves: PlayMove[], builds: BuildOrder[]) => void;
  onResolveBattles: () => void;
  onFinish: (reason: string, leaveDelay?: number) => void;
}) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<PlayMove[]>([]);
  const [builds, setBuilds] = useState<BuildOrder[]>([]);
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
  const queuedCount = orders.length + buildOrders.length;

  // A new round means both plans resolved; clear the local submission.
  useEffect(() => {
    setSelectedIds([]);
    setDraft([]);
    setBuilds([]);
    setSubmitted(false);
  }, [state.turn]);

  // The battle phase locks planning. Drop the queued markers so the board shows
  // the conflict itself rather than orders that were held at the border.
  useEffect(() => {
    if (state.phase === "battle") {
      setSelectedIds([]);
      setDraft([]);
      setBuilds([]);
    }
  }, [state.phase]);

  const removeOrder = (unitId: string) => {
    setDraft((current) => current.filter((move) => move.unitId !== unitId));
  };

  const removeBuild = (builderId: string) => {
    setBuilds((current) => current.filter((order) => order.builderId !== builderId));
  };

  const addBuild = (builderId: string, typeId: PlayUnitType) => {
    if (submitted || state.phase === "battle") return;
    // One action per piece: a build replaces that piece's queued move.
    setDraft((current) => current.filter((move) => move.unitId !== builderId));
    setBuilds((current) => [
      ...current.filter((order) => order.builderId !== builderId),
      { builderId, typeId },
    ]);
    setSelectedIds([]);
  };

  const toggleSelection = (unitId: string) => {
    setSelectedIds((current) => toggleSelectedIds(state, current, unitId));
  };

  const onTileClick = (tile: MapTile) => {
    const group = selectedUnits;
    const canGroupMove =
      !submitted &&
      group.length > 0 &&
      group.every((unit) => canUnitMoveTo(state, unit, tile.col, tile.row));

    if (canGroupMove) {
      const ids = new Set(group.map((unit) => unit.id));
      setDraft((current) => [
        ...current.filter((move) => !ids.has(move.unitId)),
        ...group.map((unit) => ({
          unitId: unit.id,
          col: tile.col,
          row: tile.row,
        })),
      ]);
      setBuilds((current) => current.filter((order) => !ids.has(order.builderId)));
      setSelectedIds([]);
      setInspectedId(tile.id);
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
    onSubmit(draft, builds);
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
            onToggle={toggleSelection}
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
                  : "Select one or more pieces on a hex, march them together, then submit. Workers harvest when the round resolves."}
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
                {orders.map(({ move, unit }) => (
                  <li key={unit.id} className={`play-order owner-${unit.owner}`}>
                    <span className="play-order-move">
                      <strong>{UNIT_LABEL[unit.typeId]}</strong>{" "}
                      {tileLabel(unit.col, unit.row)} → {tileLabel(move.col, move.row)}
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
                ))}
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
                piece stacked there.
              </li>
              <li>
                Choose one or more Workers or Soldiers in the panel, then click a
                highlighted adjacent hex. The whole group marches together.
              </li>
              <li>
                Select a single Worker to open the build window for its hex:
                Refinery, Barracks and Factory unlock as you own their
                prerequisites. Select a Base to train a Worker. Building spends
                that piece's action for the round.
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
            tile.resource ? `has-resource resource-${tile.resource}` : "",
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
              aria-label={`${tileLabel(tile.col, tile.row)}${tile.resource ? `, ${tile.resource}` : ""}${
                owner ? `, occupied by ${PLAYER_LABEL[owner]}` : ""
              }${draftMoves.length > 0 ? ", queued move here" : ""}${
                buildHere > 0 ? ", construction queued here" : ""
              }${conflictTarget ? ", conflict" : ""}`}
            >
              <span className="hex-face">
                {tile.resource && (
                  <span className={`hex-resource ${tile.resource}`} aria-hidden="true">
                    {RESOURCE_GLYPH[tile.resource]}
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
  const trains = builder.typeId === "base";
  return (
    <div className="play-build">
      <div className="play-build-head">
        <h4>{trains ? "Train here" : "Build here"}</h4>
        <span className="muted small">
          {tileLabel(builder.col, builder.row)}
        </span>
      </div>
      <p className="muted small">
        {trains
          ? "The Base spends its action to train a Worker on this hex."
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

function HexInspector({
  state,
  tile,
  viewer,
  selectedIds,
  onToggle,
  draft = [],
  builds = [],
  onBuild,
  disabled = false,
}: {
  state: PlayState;
  tile: MapTile | undefined;
  viewer: Player;
  selectedIds: string[];
  onToggle: (unitId: string) => void;
  draft?: PlayMove[];
  builds?: BuildOrder[];
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
    (getDefinition(unit.typeId).kind !== "structure" ||
      buildOptions(state, viewer, unit.id).length > 0);
  const hasSelectable = occupants.some(canAct);
  const selectedPieces = selectedIds
    .map((id) => unitById(state, id))
    .filter((unit): unit is PlayUnit => unit !== undefined);
  const onlyPiece = selectedPieces.length === 1 ? selectedPieces[0] : undefined;
  const builder =
    !disabled && onlyPiece !== undefined && onlyPiece.owner === viewer
      ? onlyPiece
      : undefined;
  const options = builder ? buildOptions(state, viewer, builder.id) : [];
  const queuedBuild = builder
    ? builds.find((order) => order.builderId === builder.id)
    : undefined;

  return (
    <section className="panel play-inspector">
      <div className="panel-head">
        <h3>{tile ? `Hex ${tileLabel(tile.col, tile.row)}` : "Hex contents"}</h3>
        {tile && !enemy && tile.resource && (
          <span className="muted small">{tile.resource}</span>
        )}
      </div>

      {!tile ? (
        <p className="muted small">
          Click a hex to inspect it. Your own hexes list every piece stacked
          there.
        </p>
      ) : enemy && !revealEnemy ? (
        <p className="play-inspector-enemy">Occupied by enemy</p>
      ) : occupants.length === 0 ? (
        <p className="muted small">
          Empty hex{tile.resource ? ` with ${tile.resource}` : ""}.
        </p>
      ) : (
        <>
          <p className="muted small">
            {occupants.length} piece{occupants.length === 1 ? "" : "s"} ·{" "}
            {PLAYER_LABEL[owner ?? viewer]}
            {revealEnemy ? " · revealed by conflict" : ""}
          </p>
          <ul className="play-inspector-list">
            {occupants.map((unit) => {
              const order = draft.find((move) => move.unitId === unit.id);
              const build = builds.find((entry) => entry.builderId === unit.id);
              const selectable = canAct(unit);
              const hp = unitHp(unit);
              const maxHp = getDefinition(unit.typeId).hp;
              const isStructure = getDefinition(unit.typeId).kind === "structure";
              const note = build
                ? `Building ${UNIT_LABEL[build.typeId]}`
                : unit.typeId === "base"
                  ? "Structure · cannot move · trains Workers"
                  : isStructure
                    ? "Structure · cannot move"
                    : unit.moved
                      ? "Already acted"
                      : order
                        ? `Queued → ${tileLabel(order.col, order.row)}`
                        : "Ready to move";
              return (
                <li key={unit.id}>
                  <button
                    type="button"
                    className={`play-piece${selectedIds.includes(unit.id) ? " is-selected" : ""}`}
                    onClick={() => onToggle(unit.id)}
                    disabled={!selectable}
                  >
                    <span
                      className="play-piece-glyph"
                      style={{ color: typeColor(unit.typeId) }}
                      aria-hidden="true"
                    >
                      {getDefinition(unit.typeId).glyph}
                    </span>
                    <span className="play-piece-body">
                      <strong className="play-piece-name">
                        {UNIT_LABEL[unit.typeId]}
                      </strong>
                      <span className="play-piece-note">
                        {note}
                        {hp < maxHp ? ` · ${hp}/${maxHp} HP` : ""}
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
              {selectedIds.length > 0
                ? `${selectedIds.length} selected. Click a highlighted neighbour to march the group together.`
                : "Select one or more pieces, then click a highlighted neighbouring hex. Select a single Worker or Base to build."}
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
  }, [state.active]);

  const reset = () => {
    setState(createInitialState());
    setSelectedIds([]);
    setInspectedId(null);
  };

  const toggleSelection = (unitId: string) => {
    setSelectedIds((current) => toggleSelectedIds(state, current, unitId));
  };

  const onBuild = (builderId: string, typeId: PlayUnitType) => {
    const next = buildUnit(state, state.active, builderId, typeId);
    if (next !== state) {
      setState(next);
      setSelectedIds([]);
    }
  };

  const onTileClick = (tile: MapTile) => {
    const group = selectedUnits;
    const canGroupMove =
      group.length > 0 &&
      group.every((unit) => canMoveTo(state, unit, tile.col, tile.row));

    if (canGroupMove) {
      const next = moveUnits(
        state,
        group.map((unit) => unit.id),
        tile.col,
        tile.row,
      );
      if (next !== state) {
        setState(next);
        setSelectedIds([]);
        setInspectedId(tile.id);
      }
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

  const status =
    state.phase === "battle"
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

      <div className="play-layout has-inspector">
        <aside className="stack play-aside">
          <HexInspector
            state={state}
            tile={inspectedTile}
            viewer={state.active}
            selectedIds={selectedIds}
            disabled={state.phase === "battle"}
            onToggle={toggleSelection}
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
                {state.phase === "battle"
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

          <StarterBoard
            state={state}
            selectedIds={selectedIds}
            inspectedId={inspectedId}
            onTileClick={onTileClick}
            disabled={state.phase === "battle"}
            canReach={(unit, col, row) => canMoveTo(state, unit, col, row)}
          />

          <div className="play-actions">
            <span className="muted small">
              {state.phase === "battle" ? (
                "The battle phase must be resolved before the turn can end."
              ) : (
                <>
                  Ending the turn collects <strong>{stockSummary(income)}</strong>.
                </>
              )}
            </span>
            {state.phase === "battle" ? (
              <button className="btn primary" onClick={resolveBattlePhase}>
                Resolve battles
              </button>
            ) : (
              <button className="btn primary" onClick={finishTurn}>
                End {PLAYER_LABEL[state.active]}'s turn
              </button>
            )}
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
                Workers or Soldiers from the hex panel.
              </li>
              <li>
                Click a highlighted neighbouring hex to move the whole group.
                Any number of allied pieces can share a hex.
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
                Each unit moves once per turn. Bases hold their edge, but a
                selected Base can train a Worker on its own hex.
              </li>
              <li>
                Select a single Worker to build a structure on its hex. A Base
                unlocks Refinery and Barracks; a Barracks unlocks the Factory.
                Building uses the piece's action.
              </li>
              <li>
                End the turn to harvest: every Worker standing on a ◆ mineral or ▲ gas
                node adds 1 to your stock, even when Workers are stacked.
              </li>
              <li>
                Harvested resources pay for construction and training. Each side
                starts with 4◆.
              </li>
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}
