# Rules decisions and open questions

Where `BoardGame.docx` is silent or ambiguous, the app has to pick a reading. This
file records what has been decided and what still needs table time. Each decision
maps to a small, tested piece of `src/game/battle.ts`, `src/game/play.ts` or
`src/game/codex.ts`.

## Settled

**Income** — a Base on a mineral node turns up to three assigned Workers into
minerals at 1 each; a Refinery on a gas node does the same for gas. Extra Workers
add nothing, structures off their matching node produce nothing, and only the
worker owner's structures count. A hex holding both a Base and a Refinery assigns
each Worker to the structure chosen when it moved in; selecting the Worker and
clicking its own hex re-picks the structure for later rounds. The Turn Flow income
panel caps each structure at three.

**Supply** — the printed card counts are a hard per-player limit:

| Card | Limit | Card | Limit |
| --- | --- | --- | --- |
| Worker | 12 | Base | 6 |
| Soldier | 12 | Barracks | 8 |
| Walker | 12 | Factory | 6 |
| Artillery | 9 | Refinery | 5 |

The Battle Lab disables an "add" chip at the cap, and the Codex shows the limit on
every card.

**Build times** — everything builds in one turn. You pay during the Construction
phase and the card is ready at the start of your next turn, so "Advance
construction" became "Complete construction".

**Retreats** — retreating units deal no damage. They become non-threatening, can be
skipped as targets, and leave after any band that deals damage. This keeps the
structures-only clause consistent: a side that withdraws everything and leaves
buildings behind does not shoot back. Retreats can be chosen before the battle
starts and again at the start of every round — the first round prompt appears
after outnumber damage. Units that leave are kept in the roster as retreated
cards: greyed out, untargetable, and excluded from fighting and from survivors.

**Targeting is a per-round choice.** Damage walks the defending line once, front
to back. Threatening cards always take damage and cannot be skipped.
Non-threatening cards default to Target but the defender may mark any of them
Skip at the start of the round; skipped cards are bypassed and the damage moves
on to the next card. The marks apply to all three bands in that round and reset
at the start of the next one. Damage left over after the end of the line is lost.

## Engine assumptions still worth confirming

These are implemented and tested, but they are readings rather than decisions.

**Outnumber counting.** Living units count, including units currently marked
retreating; structures never count and are not counted as "units" in the comparison.

**Outnumber targeting.** The free damage follows the normal front-to-back targeting
rules, so it can be split across the line and can hit structures in the way.

**Outnumber rounding.** `(larger − smaller) ÷ 2`, rounded down, applied only when the
larger side has at least double the smaller side's units. Ties do nothing.

**Structures-only loop.** Exactly one unopposed loop (long, mid, melee), then the
battle ends. On the Play map a surviving defender structure keeps the contested
hex even when every defending unit is gone.

**Both sides reduced to structures.** Treated as a draw; the defender keeps the
contested hex, consistent with "the attacking force stays on their adjacent hex".

**Damage assignment is a defender choice, not an attacker policy.** Each pass
walks the line once; threatening cards must take damage, non-threatening cards
follow the Target/Skip marks set at the start of the round. Damage that reaches
the end of the line is forfeited, and the log says so.

**Retreats and target marks are chosen per round.** Units marked in the Battle
Lab start round 1 as retreating; the round-start prompt lets either side add or
remove marks and flip Target/Skip before each round's bands resolve. A retreat
declared with no legal hex is ignored for that round and the units turn upright.
Units that leave are gone for later rounds and stay visible as greyed-out,
untargetable cards.

**Range bands are combat math, not board reach.** Damage goes to an adjacent army
regardless of band; long range does not shoot two hexes away.

**Play mode is a starter map, not the full game.** The Play tab uses a fixed
nineteen-hex odd-r grid shaped as a large hex three hexes along each side, with
Player A on the top edge and Player B on the bottom edge. The middle hex of each
side carries both a mineral node and a gas node; Bases and Refineries only produce
while standing on their matching node. Any number of pieces from one side may
stack on a hex. An occupied hex shows only a dot in its owner's colour; clicking
one of your own hexes lists every piece in the left-hand hex panel, while an enemy
hex reports only "Occupied by enemy" during planning. Conflict reveals the
defending garrison.

Rounds are simultaneous: from one hex, select any number of mobile pieces (Bases
never move) and queue them to the same adjacent destination. Allied hexes and
hexes targeted by other allied moves are valid destinations, so armies merge
whether one moves into another or several meet on an empty hex. Enemy-held hexes
are valid too. Resolution is staged: construction first, then uncontested
arrivals; any hex that would then hold both sides in the same round becomes a
conflict, the attacking groups stay in their origin hexes, and the round pauses
in the battle phase. The host resolves each conflict with the battle engine (no
retreats, automatic targeting), writes surviving HP back to the map, and the
attacking survivors take the hex only when every defending unit is destroyed; a
surviving defender structure keeps the hex. A head-on clash over an empty hex
arbitrarily treats Player B as the defender. After the battle phase, each Base on
a mineral node turns up to three assigned Workers into minerals at 1 each, and
each Refinery on a gas node does the same for gas. Extra Workers add nothing and
off-node structures produce nothing; a dual hex assigns each Worker to the
structure chosen when it moved in. The round then advances. Online conflict
resolution is host-authoritative; practice resolves an attack immediately on
click instead of planning it simultaneously.

Construction is deliberately compressed into the same round. A selected Worker
builds any structure on its own hex, a selected Base trains a Worker, and a
selected Barracks trains a Soldier; either way the piece spends its action and
cannot move that round. A building Worker also does not gather income that round,
and selecting a stack of Workers lets each one build in turn. Refinery and
Barracks require any owned Base, and Factory
requires any owned Barracks, so unlocks are per player rather than per hex. Costs
are the codex costs — Base 8◆, Refinery 3◆, Barracks 5◆, Factory 6◆2▲, Worker
2◆, Soldier 3◆ — and supply caps are the printed per-player counts. Each side
starts with 4◆ and 0▲ so the first construction phase can do something. Build
orders and Base/Refinery harvest choices travel in the online
Submit payload and are validated by the host; invalid or unaffordable orders are
ignored like forged moves. The simplification is that builds complete immediately
at resolution rather than advancing over a separate construction timer.

The board is shared by two paired players: the host collects both submissions and
resolves the round, while the guest sends its plan. Either side can forfeit.
Matching codes are 5 characters.

**Real-time transport is peer-to-peer.** Cross-device games use WebRTC with the
public PeerJS broker for the initial handshake; no game state touches a server.
The trade-off is that restrictive networks can block the connection, and the
public broker is a third-party dependency. Same-browser tabs fall back to
`BroadcastChannel`, which also makes the flow usable offline. Async/resumable
play would still need a server.

## Still open

**Repair.** "Can repair" is mentioned once, with no cost or rate. Not modelled.

**Maneuver tokens.** How many a player gets per turn is not stated.

**Stacking.** The full game gives no limit for armies per hex or for combining two
armies. The Play starter map now lets any number of allied pieces share a hex as a
deliberate simplification; how stacking should work on the real map is still open.

**Randomness.** Conflicts and battles resolve in random order. A physical game
uses a die; an app needs a seed both players can verify. The Play map currently
resolves conflicts in a deterministic target order rather than rolling, and the
Battle Lab resolves a single fight on demand.

**Worker combat.** Workers deal 1 melee damage and are non-threatening. That is a
real, interesting choice on the battlefield — worth confirming it is intended rather
than an artefact of filling in the template.

## Roadmap

Ordered by how much each adds to a playtest:

1. **Batch simulation** — run a matchup 1,000 times and report win rates. Fastest
   route to balancing costs without table time.
2. **Multi-hex battles** — conflict chains across several hexes, damage split
   across adjacent armies, outnumber across whole teams.
3. **Map layer** — grow the Play map into the real thing: variable boards, armies
   as stacks, maneuver tokens, full construction timers and the full battle
   hand-off. The starter large-hex map, grouped moves, conflicts, construction and
   the battle phase are the first slice.
4. **Async play** — server-backed, resumable turns so a game can survive both
   players closing their tabs. Live play is already peer-to-peer; persistence and
   matchmaking without a shared code would need a backend.
