# Sector:Gridfall — Companion

A web companion for the hex-and-army board game described in `BoardGame.docx`.
It is a **design and playtest tool**, not a full digital tabletop: it holds the
rules-derived data, resolves battles exactly as written, walks players through a
turn, and includes a small starter map you can actually play.

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # rules-engine tests
npm run build    # production build in dist/
```

Node 18+ required. On Windows, if `npm` is blocked by an execution policy, run
commands through `cmd /c "npm ..."`.

## Deploying to Surge

The app is static, so any static host works. With Surge:

```bash
npm run build                 # writes dist/
npx surge dist myboardgame.surge.sh
```

The first run asks for an email and password and creates the Surge account. If you
omit the domain, Surge generates one; you can also point a custom domain at it.
HTTPS is automatic.

`dist/` is gitignored, so always build before publishing. If you later add
client-side routing, copy `dist/index.html` to `dist/200.html` so deep links resolve;
the current version has no routes, so that isn't needed yet.

Watch out for one thing when sharing the link: the checklist, army setups, map
state and notes live in `localStorage`, which is per browser and per device. Two
players opening the same URL get independent state — that's fine for a table-side
tool. The Play tab is the exception: use **Host Game** / **Join Game** to pair two
browsers and share one board state.

## What's in it

**Codex** — every unit and structure with cost, HP, damage, range, threatening
status, supply limit, what it produces and what it unlocks, plus the build tree.

**Battle Lab** — builds two armies and resolves the fight through the full damage
loop. It enforces outnumber damage, simultaneous range bands, a single
front-to-back damage pass, and the unopposed loop against an army reduced to
structures. At the start of every round — the first one included — you choose
which units retreat and mark each non-threatening card **Target** or **Skip**;
threatening cards always take damage, and the marks hold for all three bands that
round. Each pass logs the whole defending line in order: card, remaining HP,
Target/Skip, and damage taken. Damage still left when the line ends is lost.
Destroyed cards stay listed in red, successfully retreated cards grey out and
become untargetable, and adding a card is blocked at its supply limit.

**Turn Flow** — the phase checklist in the order the rules require, plus an
income calculator and a notes pad. Progress and notes are kept in
`localStorage`, so they survive a refresh.

**Play** — opens on a matching screen. One player clicks **Host Game** and shares
the five-character code; the other enters it under **Join Game**. Once paired, the
matching screen gives way to the starter map: a large hexagon three hexes along
each side, with Player A on the top edge and Player B on the bottom edge. The
middle hex of each side carries a mineral node and a gas node. Each side starts
with a Base and three Workers standing on it; there are no Soldiers until a
Barracks trains one. An occupied hex shows a dot in its owner's colour rather
than every piece. Click one of your hexes
to list everything stacked there in the hex panel on the left. Identical pieces
share a row such as "Soldier x3", and Workers name their assigned structure such
as "Worker (Base) x3" or "Worker (Refinery)"; clicking a row selects the whole
stack. Select any number of Workers or Soldiers, then click a highlighted
neighbour to queue the whole group's move. When a stack has more than one piece,
a prompt asks how many of that stack march; the rest hold the hex, and the movers
are labelled `(moving)` in the hex panel. Allied hexes are valid destinations, so
moving one army into another merges them; two allied groups can also meet on the
same empty hex. Enemy-held hexes are valid destinations too: if the enemy vacates
in the same round, your army moves in, but if the enemy stays the border turns red
and the round pauses for the battle phase. Structures never move.

Select a Worker or a stack of Workers to open a build window for that hex:
Refinery, Barracks and Factory become buildable as their prerequisites are owned.
A Base trains Workers and a Barracks trains Soldiers. The selected piece spends
its action for the round, so it cannot also move or gather income. Build orders
are queued alongside moves and shown on the board and in the Orders panel until
you submit.

Both players plan at the same time, then click **Submit**. When both sides have
submitted, construction resolves first, then uncontested moves, then every
conflict is fought with the same battle engine as the Battle Lab. The host
resolves the battle phase; the guest sees the conflict borders and waits. Damage
persists between rounds, and a surviving defender structure keeps its hex even
when every defending unit is gone. Losing every structure eliminates a player:
the other side wins, and if both sides lose their last structure in the same
round the game is a draw. After the battles each Base on a mineral node turns up
to five assigned Workers into minerals, and each Refinery on a gas node turns up
to three into gas. Extra Workers beyond those caps add nothing, and a structure
off a matching node produces nothing. When a hex holds both structures, each Worker is
assigned to the one chosen when it moved in; select one or more Workers and click
their own hex (or use Split harvest) to reassign them, choosing how many go to
minerals and how many to gas. The next round then begins. Resources
buy builds. **Forfeit** declares the opponent the winner and returns both players
to matching.

Host and guest connect directly over WebRTC (signalled by the free PeerJS broker).
Tabs in the same browser also pair over `BroadcastChannel`, so a code works offline
on one device and the flow can be tested where WebRTC is unavailable. **Practice
locally** keeps the hotseat starter map and the Amazons / Pferdeäppel
variants.

## Project layout

```
src/game/types.ts       cards, costs, range bands
src/game/codex.ts       stat blocks transcribed from BoardGame.docx
src/game/battle.ts      the battle rules engine (framework-free, unit tested)
src/game/battle.test.ts damage loop, targeting, outnumber and per-round choices
src/game/play.ts        starter-map moves, conflicts, battle hand-off and harvesting
src/game/play.test.ts   map shape, grouped moves, conflicts, battles, harvesting and round resolution
src/lib/match.ts        code matchmaking: PeerJS plus BroadcastChannel fallback
src/game/codex.test.ts    stat blocks and printed card counts
src/components/         Codex, Battle Lab, Turn Flow and Play views
docs/OPEN_QUESTIONS.md  decisions made, assumptions still worth confirming
```

The engines in `src/game/` have no React or DOM dependency. If the app later
moves to async multiplayer or a server, those modules come along unchanged.

## Rules decisions

Settled with the designer:

- **Income** — a Base on a mineral node turns up to five assigned Workers into 5
  minerals; a Refinery on a gas node turns up to three into 3 gas. Additional
  Workers add nothing, structures off a matching node produce nothing, and enemy
  structures never produce for you. When a hex holds both your Base and Refinery, each Worker
  joins the structure chosen when it moved in; selecting one or more Workers and
  clicking their own hex (or using Split harvest) reassigns them, with a count
  for minerals and a count for gas.
- **Elimination** — a player with no structures left is out and the opponent wins.
  Both sides losing their last structure together is a draw.
- **Supply** — the printed card counts are hard per-player limits (12 workers, 12
  soldiers, 12 walkers, 9 artillery, 6 Bases, 8 Barracks, 6 Factories, 5 Refineries).
- **Builds** — every card takes one turn.
- **Building on the starter map** — Workers construct structures, Bases train
  Workers and Barracks train Soldiers; the builder spends its action for the
  round. A Base unlocks Refinery and Barracks, and a Barracks unlocks the Factory.
  Unlocks are per player, not per hex. Each side opens with 4 minerals and 0 gas
  so construction can start immediately, and builds cost the codex prices: Base
  8◆, Refinery 3◆, Barracks 5◆, Factory 6◆2▲, Worker 2◆, Soldier 3◆.
- **Retreats** — retreating units deal no damage, are non-threatening, can be
  skipped as targets, and leave after any band that deals damage. You can change
  the retreat list at the start of every round; units that leave stay gone.
- **Targeting** — damage walks the defending line once, front to back.
  Threatening cards always take damage. Non-threatening cards default to Target
  and can be marked Skip for the round. Leftover damage after the end of the line
  is lost.

Everything else the engine had to assume is listed in
[`docs/OPEN_QUESTIONS.md`](docs/OPEN_QUESTIONS.md).

## Scope

The Battle Lab resolves **one army per side**, which is the atomic battle from
the rules. The Play tab is a deliberately small two-player skirmish: a fixed
nineteen-hex map shaped as a large hex, unlimited allied stacking on a hex,
grouped moves from one hex per round, simultaneous resolution, construction,
Worker/Soldier training, conflict detection and an auto-resolved battle phase
before Worker harvesting. Conflict chains that span
several hexes, the full map, maneuver tokens, escorting and multi-turn production
timers are not modelled yet. See the roadmap in the open questions doc.

`BoardGame.docx` remains the source of truth for the rules.
