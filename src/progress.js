// Long-term progression between raids: a base you build up with credits and specific loot. Everything is stored in the saved stash.

// Each level sets a flag in stash.upgrades that the raid reads. `need` is loot that must be in the stash to build it.
export const STATIONS = [
  { id: 'locker', name: 'Locker room', levels: [
    { flag: 'pack', desc: '+4 pack slots', cost: 1500, need: [['Cable Reel', 2]] },
    { flag: 'pouch', desc: 'Secure pouch: your best item survives death', cost: 2000, need: [['Coolant Cell', 1]] }] },
  { id: 'med', name: 'Med bay', levels: [
    { flag: 'medic', desc: 'Deploy with 3 medkits', cost: 1000, need: [['Field Dressing Case', 1]] },
    { flag: 'health', desc: '+25 maximum health', cost: 2500, need: [['Servo Core', 1]] }] },
  { id: 'bench', name: 'Workbench', levels: [
    { flag: 'suppressor', desc: 'Pistol suppressor: guards hear it from a quarter of the distance', cost: 1800, need: [['Optic Lens', 1]] },
    { flag: 'armor', desc: 'Deploy with 50 armour', cost: 2500, need: [['Gold Bearing', 1]] }] },
  { id: 'comms', name: 'Comms room', levels: [
    { flag: 'scout', desc: 'Guards are marked on your map for the first 30 s of a raid', cost: 1200, need: [['Signal Relay', 1]] },
    { flag: 'time', desc: '+90 s on the raid clock', cost: 2000, need: [['Data Slate', 2]] }] },
];

// The two traders and their task lists were cut (design by subtraction); the empty list keeps old saves loading.
export const TRADERS = [];

const matches = (it, h) => it && it.t === 'loot' && (h.name ? it.name === h.name : it.tier === h.tier);
export const countItem = (stash, name) => (stash.grid || []).filter((it) => it && it.t === 'loot' && it.name === name).length;
export const stationLevel = (stash, st) => { let n = 0; for (const l of st.levels) { if (stash.upgrades[l.flag]) n++; else break; } return n; };
export function canBuild(stash, level) { return stash.credits >= level.cost && level.need.every(([name, n]) => countItem(stash, name) >= n); }
export function build(stash, level) {
  if (!canBuild(stash, level)) return false;
  stash.credits -= level.cost;
  for (const [name, n] of level.need) for (let k = 0; k < n; k++) { const i = stash.grid.findIndex((it) => it && it.t === 'loot' && it.name === name); stash.grid[i] = null; }
  stash.upgrades[level.flag] = true; return true;
}

export function taskState(stash, trader) {
  if (!stash.tasks) stash.tasks = {};
  const s = stash.tasks[trader.id] || (stash.tasks[trader.id] = { i: 0, n: 0 });
  const task = trader.tasks[s.i] || null;
  if (!task) return { task: null, done: false, have: 0, need: 0, s };
  const have = task.handin ? (stash.grid || []).filter((it) => matches(it, task.handin)).length : s.n, need = task.handin ? task.handin.n : task.n;
  return { task, done: have >= need, have: Math.min(have, need), need, s };
}
// count something done in a raid toward whichever trader currently wants it
export function bump(stash, stat, amount = 1) {
  for (const tr of TRADERS) { const { task, s } = taskState(stash, tr); if (task && task.stat === stat) s.n = Math.min(task.n, s.n + amount); }
}
// pay out a finished task; `give` puts a reward item into the stash
export function claim(stash, trader, give) {
  const { task, done, s } = taskState(stash, trader);
  if (!task || !done) return false;
  if (task.handin) for (let k = 0; k < task.handin.n; k++) { const i = stash.grid.findIndex((it) => matches(it, task.handin)); stash.grid[i] = null; }
  stash.credits += task.reward.cr; for (const it of task.reward.items) give({ ...it });
  s.i++; s.n = 0; return true;
}
