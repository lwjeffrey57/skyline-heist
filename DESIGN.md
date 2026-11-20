# Skyline Heist — design brief

Read this before changing anything. It is the shared brief for every person and agent working on the game.

## What the game is
A single-player extraction shooter in the browser (Three.js + Vite). You deploy into a walled compound with a
pistol, loot it, fight its guards, and get out through an exit with what you carry. Die and you lose it.

## The vision: go in quiet, come out loud
A raid opens tense and careful and ends as a running fight. Stealth is the opening act; as heat rises the player
is meant to cut loose, and fast movement (sprint, slide-hop, vault, dash) and strong gunplay are the tools for
getting out alive with the haul. The game should be exciting to play, with sick gunplay and movement.
Test every mechanic against this: does it make the quiet start tenser, or the loud finish more thrilling? If it
does neither, or it makes the player feel slow, helpless or bored, it does not belong.

Consequences already decided:
- The shop sells only basic gear. The best guns and attachments can only be found, so finding one matters.
- Enemy types must each demand a different response from the player, not just more bullets.
- Intensity should rise and fall: after a hard fight the game allows a lull; when it has been quiet too long it stirs.
- The map is fixed and learnable (src/world2.js, a blockout for now). Things may persist between raids.
- Design by subtraction: features that do not serve the vision get cut. Cut so far: the two traders, the two
  recoloured guns (one gun per role), the deathmatch mode. Resting only heals to 40%; the rest takes a medkit.
- Gun feel is tuned by the player in the firing range (src/range.js, button on the stash screen); their numbers
  are pasted back and baked into src/weapons/defs.js.

## Pillars, in priority order
1. **The gunplay must feel amazing.** Shooting an enemy has to be a pleasure in itself: enemies visibly and audibly
   react to every hit, deaths respond to the shot that caused them, guns sound and kick with weight. If a change
   does not make fights feel better, it is probably not the next thing to do.
2. **Raids escalate.** A raid starts quiet and tense and ends loud and desperate. The more enemies
   you kill, the hotter the compound gets (`ctx.raid.heat`, 0..1, and `ctx.raid.heatTier`, 1..5): more and tougher
   opposition, faster reinforcements, guards that hunt you — and richer loot and a bigger payout if you get out.
   The stakes must feel more real the deeper into a raid you are.
3. **Contracts give each raid a purpose.** Two optional objectives per raid that pull you toward specific places
   and ways of playing.
4. **Everything added must create a decision.** No filler. If a feature does not make the player choose something
   on the way in, in the fight, or on the way out, it does not go in.

## What we are not doing
- No more systems or content until fights and pacing feel good. Depth before breadth.
- No multiplayer, no new maps, no bigger map.
- No copying any existing game's names, characters, art, maps or UI. Borrow ideas, not content.

## How the code is organised
- `src/core.js` — the contract between systems: `ctx`, events, `hitscan`. Read its header comment.
- `src/main.js` — builds `ctx`, runs each system's `update(dt)` every frame.
- Systems and who may edit them (never edit a file you do not own; ask for a change instead):
  - enemies: `src/bots.js`, `src/bots/*`
  - weapons and weapon HUD: `src/weapons.js`, `src/weapons/*`
  - effects and sound: `src/fx.js`, `src/fx/*`, `src/audio.js`, `src/audio/*`
  - rendering and materials: `src/render.js`, `src/materials.js`, `src/decor.js`, `src/visuals/*`
  - destruction: `src/destruction.js`, `src/destruction/*`
  - everything else (world, player, raid, inventory, map, UI, drones, turrets): the coordinator
- Systems talk only through `ctx` and events. Emit an event for anything another system might want to react to.

## Testing
- Dev server: `PORT=5173 npx vite` (one shared server; do not run `vite build`; do not commit).
- `NODE_PATH=/opt/node22/lib/node_modules node tools/smoke.cjs 5173 script.js out.png` loads the game, runs
  `script.js` in the page and saves a screenshot. In the page: `__game.ctx.raid.deploy()` starts a raid,
  `__game.step(1/60)` advances time, `__game.player.protectT = 999` makes the player invulnerable,
  `__game.ctx.bots.setCount(n)` sets guard numbers. There is no GPU here: judge visuals from screenshots, not fps.
- Nobody in this environment can hear audio or feel the controls. Verify by measurement and screenshots, and say
  plainly in your report what a human still needs to judge.
