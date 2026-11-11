// Snake Online - 多人在线贪吃蛇
// Cloudflare Worker + Durable Objects

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/room/")) {
      const room = url.pathname.split("/")[2].toUpperCase();

      if (!/^[A-Z0-9]{4,8}$/.test(room)) {
        return new Response("房间号无效", { status: 400 });
      }

      const id = env.ROOMS.idFromName(room);
      return env.ROOMS.get(id).fetch(request);
    }

    return new Response(PAGE, {
      headers: {
        "Content-Type": "text/html; charset=utf-8"
      }
    });
  }
};

export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.players = new Map();
    this.food = [];
    this.orbs = [];
    this.bigFood = null;
    this.started = false;
    this.lastBigFood = 0;
  }
    async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocket required", { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    const url = new URL(request.url);
    const name = (url.searchParams.get("name") || "玩家").slice(0, 8);

    if (this.players.size >= 3) {
      server.accept();
      server.send(JSON.stringify({
        type: "error",
        message: "房间已满，最多只能有3名玩家"
      }));
      server.close();

      return new Response(null, {
        status: 101,
        webSocket: client
      });
    }

    const id = crypto.randomUUID().slice(0, 8);
    const colors = ["#38bdf8", "#fb7185", "#a78bfa"];

    const player = {
      id,
      name,
      color: colors[this.players.size % colors.length],
      x: 100 + Math.random() * 500,
      y: 100 + Math.random() * 300,
      dir: { x: 1, y: 0 },
      body: [],
      score: 0,
      alive: true,
      boost: false,
      ability: "",
      abilityUntil: 0,
      cooldown: 0
    };

    for (let i = 0; i < 5; i++) {
      player.body.push({
        x: player.x - i * 12,
        y: player.y
      });
    }

    server.serializeAttachment({ id });
    this.ctx.acceptWebSocket(server);
    this.players.set(id, player);

    if (this.food.length === 0) {
      for (let i = 0; i < 20; i++) {
        this.spawnFood();
      }
    }

    this.broadcast();
    await this.scheduleTick();

    return new Response(null, {
      status: 101,
      webSocket: client
    });
    }
    webSocketMessage(ws, message) {
    let data;

    try {
      data = JSON.parse(message);
    } catch {
      return;
    }

    const attachment = ws.deserializeAttachment();
    if (!attachment) return;

    const p = this.players.get(attachment.id);
    if (!p) return;

    if (data.type === "input" && data.dir) {
      const dx = Number(data.dir.x);
      const dy = Number(data.dir.y);

      if (Math.abs(dx) + Math.abs(dy) === 1) {
        if (!(dx === -p.dir.x && dy === -p.dir.y)) {
          p.dir = { x: dx, y: dy };
        }
      }
    }

    if (data.type === "boost") {
      p.boost = !!data.value;
    }

    if (data.type === "spit" && p.alive && p.score >= 2) {
      p.score -= 2;

      const tail = p.body[p.body.length - 1] || {
        x: p.x,
        y: p.y
      };

      this.orbs.push({
        x: tail.x,
        y: tail.y,
        value: 2,
        color: p.color
      });
    }

    if (data.type === "wow" && Date.now() > p.cooldown) {
      p.cooldown = Date.now() + 5000;

      this.broadcast({
        type: "wow",
        player: p.name,
        until: Date.now() + 2500
      });
    }

    if (data.type === "pulse") {
      this.broadcast();
    }
  }

  webSocketClose(ws) {
    const a = ws.deserializeAttachment();

    if (a) {
      this.players.delete(a.id);
    }

    this.broadcast();
  }

  webSocketError(ws) {
    this.webSocketClose(ws);
  }

  async scheduleTick() {
    if (this.players.size > 0) {
      await this.ctx.storage.setAlarm(Date.now() + 120);
    }
  }

  async alarm() {
    this.tick();

    if (this.players.size > 0) {
      await this.scheduleTick();
    }
  }
    spawnFood() {
    this.food.push({
      x: 20 + Math.random() * 760,
      y: 20 + Math.random() * 460
    });
  }

  tick() {
    const now = Date.now();

    if (this.players.size >= 2) {
      this.started = true;
    }

    if (
      !this.bigFood &&
      now - this.lastBigFood > 18000 &&
      Math.random() < 0.025
    ) {
      this.bigFood = {
        x: 60 + Math.random() * 680,
        y: 60 + Math.random() * 380
      };
    }

    for (const p of this.players.values()) {
      if (!p.alive) continue;

      const speed = p.boost && p.score > 0 ? 5 : 3;

      if (p.boost && p.score > 0) {
        p.score = Math.max(0, p.score - 0.05);
      }

      p.x += p.dir.x * speed;
      p.y += p.dir.y * speed;

      p.body.unshift({
        x: p.x,
        y: p.y
      });

      p.body.pop();

      if (
        p.x < 5 ||
        p.x > 795 ||
        p.y < 5 ||
        p.y > 495
      ) {
        p.alive = false;
        continue;
      }

      for (let i = 8; i < p.body.length; i++) {
        const b = p.body[i];

        if (Math.hypot(p.x - b.x, p.y - b.y) < 9) {
          p.alive = false;
          break;
        }
      }

      if (!p.alive) continue;
            for (const other of this.players.values()) {
        if (other.id === p.id || !other.alive) continue;

        for (const b of other.body) {
          if (Math.hypot(p.x - b.x, p.y - b.y) < 10) {
            p.alive = false;
            break;
          }
        }

        if (!p.alive) break;
      }

      if (!p.alive) continue;

      const foodIndex = this.food.findIndex(f =>
        Math.hypot(p.x - f.x, p.y - f.y) < 15
      );

      if (foodIndex !== -1) {
        this.food.splice(foodIndex, 1);
        p.score += 1;

        const tail = p.body[p.body.length - 1];

        p.body.push({
          x: tail.x,
          y: tail.y
        });

        this.spawnFood();
      }

      const orbIndex = this.orbs.findIndex(o =>
        Math.hypot(p.x - o.x, p.y - o.y) < 15
      );

      if (orbIndex !== -1) {
        p.score += this.orbs[orbIndex].value;
        this.orbs.splice(orbIndex, 1);
      }

      if (
        this.bigFood &&
        Math.hypot(p.x - this.bigFood.x, p.y - this.bigFood.y) < 20
      ) {
        this.bigFood = null;
        this.lastBigFood = now;

        const abilities = ["护盾", "双倍得分", "快速成长"];

        p.ability = abilities[
          Math.floor(Math.random() * abilities.length)
        ];

        p.abilityUntil = now + 10000;

        if (p.ability === "双倍得分") {
          p.score += 10;
        }

        if (p.ability === "快速成长") {
          p.score += 5;

          for (let i = 0; i < 5; i++) {
            const tail = p.body[p.body.length - 1];

            p.body.push({
              x: tail.x,
              y: tail.y
            });
          }
        }
      }

      if (p.ability && now > p.abilityUntil) {
        p.ability = "";
      }
    }

    if (this.orbs.length > 50) {
      this.orbs.splice(0, this.orbs.length - 50);
    }

    this.broadcast();
  }
    broadcast(extra) {
    const state = {
      type: "state",
      started: this.started,

      players: Array.from(this.players.values()).map(p => ({
        id: p.id,
        name: p.name,
        color: p.color,
        body: p.body,
        score: Math.floor(p.score),
        alive: p.alive,
        ability: p.ability
      })),

      food: this.food,
      orbs: this.orbs,
      bigFood: this.bigFood
    };

    if (extra) {
      state.notice = extra;
    }

    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(JSON.stringify(state));
      } catch {}
    }
  }
}

const PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>多人贪吃蛇 Online</title>
<style>
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: #101827;
  color: #fff;
  font-family: Arial, "Microsoft YaHei", sans-serif;
  text-align: center;
}

h1 {
  font-size: 25px;
  margin: 18px 0 8px;
  color: #67e8f9;
}

.panel {
  padding: 12px;
}

input, button {
  border: 0;
  border-radius: 10px;
  padding: 12px;
  margin: 4px;
  font-size: 16px;
}

input {
  width: 120px;
  background: #263449;
  color: white;
}

button {
  background: #2563eb;
  color: white;
  font-weight: bold;
}

button:active {
  transform: scale(.96);
}
#game {
  width: 96vw;
  max-width: 800px;
  background: #172638;
  border: 2px solid #334155;
  border-radius: 12px;
  touch-action: none;
}

#status {
  margin: 10px;
  color: #cbd5e1;
}

#scores {
  margin: 8px;
  min-height: 25px;
}

.controls {
  display: grid;
  grid-template-columns: repeat(3, 65px);
  gap: 6px;
  justify-content: center;
  margin: 12px;
}

.controls button {
  height: 52px;
  font-size: 22px;
}

.actions button {
  min-width: 100px;
  margin: 5px;
}

#notice {
  color: #facc15;
  font-size: 23px;
  font-weight: bold;
  min-height: 30px;
}

.small {
  font-size: 12px;
  color: #94a3b8;
}
</style>
</head>

<body>
<h1>🐍 多人贪吃蛇 Online</h1>

<div class="panel">
  <input id="name" maxlength="8" placeholder="你的昵称">
  <input id="room" maxlength="8" placeholder="房间号">

  <button onclick="createRoom()">创建房间</button>
  <button onclick="joinRoom()">加入房间</button>

  <div id="status">创建房间或输入朋友给你的房间号</div>
  <div id="scores"></div>
  <div id="notice"></div>

  <canvas id="game" width="800" height="500"></canvas>

  <div class="controls">
    <span></span>
    <button onclick="move(0,-1)">↑</button>
    <span></span>

    <button onclick="move(-1,0)">←</button>
    <button onclick="move(0,1)">↓</button>
    <button onclick="move(1,0)">→</button>
  </div>

  <div class="actions">
    <button id="boost">按住加速</button>
    <button onclick="send({type:'spit'})">吐出经验球</button>
    <button onclick="send({type:'wow'})">碉堡了！</button>
  </div>

  <div class="small">
    电脑：方向键或 WASD。手机：点击方向键。至少2人开始，最多3人。
  </div>
</div>

<script>
const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");

let ws = null;
let roomCode = "";
let myId = "";
let latest = null;

function createRoom() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";

  for (let i = 0; i < 5; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }

  document.getElementById("room").value = code;
  connect(code);
}

function joinRoom() {
  const code = document.getElementById("room").value.trim().toUpperCase();

  if (!code) {
    alert("请先输入房间号");
    return;
  }

  connect(code);
}

function connect(code) {
  if (ws) ws.close();

  roomCode = code;

  const name =
    document.getElementById("name").value.trim() || "玩家";

  const scheme =
    location.protocol === "https:" ? "wss" : "ws";

  ws = new WebSocket(
    scheme + "://" + location.host +
    "/room/" + code +
    "?name=" + encodeURIComponent(name)
  );

  document.getElementById("status").textContent =
    "正在连接房间 " + code + "……";

  ws.onopen = () => {
    document.getElementById("status").textContent =
      "已连接！房间号：" + code + "，把房间号发给朋友吧";
  };
    ws.onmessage = e => {
    const data = JSON.parse(e.data);

    if (data.type === "error") {
      alert(data.message);
      return;
    }

    if (data.type === "state") {
      latest = data;

      if (data.notice && data.notice.type === "wow") {
        document.getElementById("notice").textContent =
          data.notice.player + "：碉堡了！";

        setTimeout(() => {
          document.getElementById("notice").textContent = "";
        }, 2500);
      }

      draw();
    }
  };

  ws.onclose = () => {
    document.getElementById("status").textContent =
      "连接已断开，请重新加入";
  };
}

function send(data) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(data));
  }
}

function move(x, y) {
  send({
    type: "input",
    dir: { x, y }
  });
}

document.addEventListener("keydown", e => {
  const k = e.key.toLowerCase();

  const dirs = {
    arrowup: [0, -1],
    w: [0, -1],
    arrowdown: [0, 1],
    s: [0, 1],
    arrowleft: [-1, 0],
    a: [-1, 0],
    arrowright: [1, 0],
    d: [1, 0]
  };

  if (dirs[k]) {
    e.preventDefault();
    move(...dirs[k]);
  }
});

const boost = document.getElementById("boost");

boost.addEventListener("pointerdown", e => {
  e.preventDefault();
  send({ type: "boost", value: true });
});

["pointerup", "pointercancel", "pointerleave"].forEach(ev => {
  boost.addEventListener(ev, () => {
    send({ type: "boost", value: false });
  });
});

function draw() {
  if (!latest) return;

  ctx.clearRect(0, 0, 800, 500);
  ctx.fillStyle = "#172638";
  ctx.fillRect(0, 0, 800, 500);

  ctx.strokeStyle = "#26384e";
  ctx.lineWidth = 1;

  for (let x = 0; x < 800; x += 25) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 500);
    ctx.stroke();
  }

  for (let y = 0; y < 500; y += 25) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(800, y);
    ctx.stroke();
  }

  latest.food.forEach(f => {
    ctx.fillStyle = "#facc15";
    ctx.beginPath();
    ctx.arc(f.x, f.y, 6, 0, Math.PI * 2);
    ctx.fill();
  });

  latest.orbs.forEach(o => {
    ctx.fillStyle = o.color;
    ctx.beginPath();
    ctx.arc(o.x, o.y, 7, 0, Math.PI * 2);
    ctx.fill();
  });

  if (latest.bigFood) {
    ctx.fillStyle = "#fb923c";
    ctx.beginPath();
    ctx.arc(
      latest.bigFood.x,
      latest.bigFood.y,
      13,
      0,
      Math.PI * 2
    );
    ctx.fill();

    ctx.fillStyle = "white";
    ctx.font = "12px Arial";
    ctx.fillText(
      "大",
      latest.bigFood.x - 5,
      latest.bigFood.y + 4
    );
  }

  latest.players.forEach(p => {
    p.body.forEach((b, i) => {
      ctx.fillStyle = p.alive ? p.color : "#64748b";
      ctx.beginPath();
      ctx.arc(b.x, b.y, i === 0 ? 9 : 7, 0, Math.PI * 2);
      ctx.fill();
    });

    if (p.body.length) {
      ctx.fillStyle = "white";
      ctx.font = "13px Arial";

      ctx.fillText(
        p.name + (p.ability ? " [" + p.ability + "]" : ""),
        p.body[0].x + 10,
        p.body[0].y - 10
      );
    }
  });

  document.getElementById("scores").textContent =
    latest.players.map(p =>
      p.name + "：" + p.score +
      (p.alive ? "" : "（淘汰）")
    ).join("　 |　 ");

  if (!latest.started) {
    document.getElementById("status").textContent =
      "等待其他玩家加入……至少2人即可开始";
  }
}
</script>
</body>
</html>`;
