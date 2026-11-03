// 把 index.html 里的算法抽出来在 Node 里跑，检查正确性。
//
// 页面是单文件、无构建的，所以测试不去改写它：用 vm 加一层最小 DOM 桩执行
// 页面脚本，再把内部的算法和绘制函数取出来验证。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] ?? path.join(here, '..', 'index.html');

const html = readFileSync(target, 'utf8');
const match = html.match(/<script>([\s\S]*?)<\/script>/);
if (!match) throw new Error('找不到 script');
const code = match[1];

const rectCalls = [];
const ctxStub = new Proxy(
  {},
  {
    get: (target, key) => {
      if (key in target) return target[key];
      if (key === 'fillRect') {
        return (...args) => rectCalls.push({ args, style: target.fillStyle });
      }
      return () => {};
    },
    set: (target, key, value) => {
      target[key] = value;
      return true;
    },
  }
);

function makeElement() {
  const base = {
    value: '42',
    textContent: '',
    dataset: {},
    style: {},
    width: 920,
    height: 340,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    getContext: () => ctxStub,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 920, height: 340 }),
    addEventListener() {},
    setPointerCapture() {},
  };
  return new Proxy(base, {
    get(target, key) {
      if (key in target) return target[key];
      return () => {};
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  });
}

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  performance: { now: () => Date.now() },
  requestAnimationFrame: (cb) => setTimeout(cb, 0),
  window: { addEventListener() {}, devicePixelRatio: 1 },
  document: {
    getElementById: () => makeElement(),
    querySelectorAll: () => [],
  },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

const api = vm.runInContext(
  '({ SORTERS, SEARCHERS, pathState, COLS, ROWS, TOTAL, generateMaze, randomObstacles, shuffled, drawSort, drawPath })',
  sandbox
);

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name} ${detail}`);
  }
}

// ---------------------------------------------------------------- 排序
console.log('排序算法：');
for (const [name, sorter] of Object.entries(api.SORTERS)) {
  let allSorted = true;
  let allSameMultiSet = true;
  let steps = 0;

  for (let trial = 0; trial < 30; trial += 1) {
    const n = 1 + Math.floor(Math.random() * 40);
    const original = Array.from({ length: n }, () => 1 + Math.floor(Math.random() * 500));
    const work = original.slice();
    let count = 0;
    for (const _step of sorter(work)) count += 1;
    steps += count;

    for (let i = 1; i < work.length; i += 1) {
      if (work[i - 1] > work[i]) allSorted = false;
    }
    const a = [...original].sort((x, y) => x - y).join(',');
    const b = [...work].sort((x, y) => x - y).join(',');
    if (a !== b) allSameMultiSet = false;
  }

  check(`${name} 结果有序`, allSorted);
  check(`${name} 元素不丢不增`, allSameMultiSet);
  check(`${name} 产生步骤`, steps > 0, `steps=${steps}`);
}

// ---------------------------------------------------------------- 寻路
console.log('寻路算法：');
const { COLS, ROWS, TOTAL } = api;
const state = api.pathState;

function validatePath(path, start, goal) {
  if (!path.length) return '空路径';
  if (path[0] !== start) return '起点不对';
  if (path[path.length - 1] !== goal) return '终点不对';
  for (let i = 1; i < path.length; i += 1) {
    const diff = Math.abs(path[i] - path[i - 1]);
    if (diff !== 1 && diff !== COLS) return `路径不连续 ${path[i - 1]}->${path[i]}`;
    if (state.walls[path[i]]) return '路径穿过墙';
  }
  return null;
}

state.walls.fill(0);
for (let i = 0; i < TOTAL; i += 1) state.cost[i] = 1 + (i % 3);

for (const [name, search] of Object.entries(api.SEARCHERS)) {
  let ok = true;
  let shortestOk = true;
  let orderOk = true;

  for (let trial = 0; trial < 20; trial += 1) {
    const start = Math.floor(Math.random() * TOTAL);
    const goal = Math.floor(Math.random() * TOTAL);
    if (start === goal) continue;
    state.start = start;
    state.goal = goal;
    const { order, path } = search(start, goal);
    const problem = validatePath(path, start, goal);
    if (problem) {
      ok = false;
      console.log(`    ${name} 问题：${problem} start=${start} goal=${goal}`);
    }
    if (order.length === 0) orderOk = false;

    // BFS 在等权网格上必须给出最短路径
    if (name === 'bfs') {
      const sx = start % COLS;
      const sy = Math.floor(start / COLS);
      const gx = goal % COLS;
      const gy = Math.floor(goal / COLS);
      const manhattan = Math.abs(sx - gx) + Math.abs(sy - gy) + 1;
      if (path.length !== manhattan) shortestOk = false;
    }
  }

  check(`${name} 路径合法`, ok);
  check(`${name} 有访问顺序`, orderOk);
  if (name === 'bfs') check(`${name} 路径最短`, shortestOk);
}

// ---------------------------------------------------------------- 迷宫
console.log('迷宫：');
api.generateMaze();
let openCells = 0;
for (let i = 0; i < TOTAL; i += 1) if (!state.walls[i]) openCells += 1;
check('迷宫有通道', openCells > TOTAL * 0.2, `open=${openCells}/${TOTAL}`);
check('起点可通行', !state.walls[state.start]);
check('终点可通行', !state.walls[state.goal]);

const mazeResult = api.SEARCHERS.bfs(state.start, state.goal);
check(
  '迷宫起点终点连通',
  mazeResult.path.length > 1 &&
    mazeResult.path[0] === state.start &&
    mazeResult.path[mazeResult.path.length - 1] === state.goal,
  `len=${mazeResult.path.length}`
);

api.randomObstacles();
let walls = 0;
for (let i = 0; i < TOTAL; i += 1) if (state.walls[i]) walls += 1;
check('随机障碍数量合理', walls > 100 && walls < TOTAL * 0.45, `walls=${walls}`);

// ---------------------------------------------------------------- 工具
const shuffled = api.shuffled(30);
check('shuffled 长度正确', shuffled.length === 30);
check('shuffled 是 1..n 的排列', new Set(shuffled).size === 30 && Math.min(...shuffled) === 1);

console.log('绘制：');
rectCalls.length = 0;
api.drawSort();
check(
  '排序画布画出全部柱子',
  rectCalls.filter((call) => call.args.length === 4).length >= 30,
  `rects=${rectCalls.length}`
);

rectCalls.length = 0;
api.drawPath();
check(
  '寻路画布画出全部格子',
  rectCalls.length >= api.TOTAL,
  `rects=${rectCalls.length}`
);

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
