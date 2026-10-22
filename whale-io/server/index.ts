import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { Connection, PublicKey } from '@solana/web3.js';
import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// Configuration
const WORLD_SIZE = 5000;
const INITIAL_RADIUS = 20;
const ROUND_DURATION = 300;
const TOKEN_MINT = process.env.TOKEN_MINT || ''; // The meme coin mint address
const SOLANA_RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';

const connection = new Connection(SOLANA_RPC);
const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/whaleio'
});

// State
const players: Map<string, any> = new Map();
const pellets: Map<string, any> = new Map();
let roundStartTime = Date.now();
let currentRoundId = 1;
let rewardPool = 0.5;

// --- Coin Verification Logic ---
async function verifyCoinHolding(walletAddress: string): Promise<boolean> {
  if (!TOKEN_MINT) return true; // Skip if no token configured
  try {
    const pubKey = new PublicKey(walletAddress);
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(pubKey, {
      mint: new PublicKey(TOKEN_MINT),
    });

    if (tokenAccounts.value.length === 0) return false;

    // Check if balance > 0
    const amount = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount;
    return amount > 0;
  } catch (e) {
    console.error('Verification error:', e);
    return false;
  }
}

// --- Database Init ---
async function initDb() {
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS rounds (
      id SERIAL PRIMARY KEY,
      start_time TIMESTAMP,
      winner_id TEXT,
      reward NUMERIC,
      status TEXT DEFAULT 'completed'
    );
    CREATE TABLE IF NOT EXISTS payouts (
      id SERIAL PRIMARY KEY,
      round_id INTEGER REFERENCES rounds(id),
      wallet TEXT,
      amount NUMERIC,
      status TEXT DEFAULT 'pending',
      tx_signature TEXT
    );
  `);
}
initDb();

function spawnPellets(count: number) {
  for (let i = 0; i < count; i++) {
    const id = `p${i}`;
    pellets.set(id, { id, x: Math.random() * WORLD_SIZE, y: Math.random() * WORLD_SIZE, color: `hsl(${Math.random() * 360}, 70%, 60%)` });
  }
}
spawnPellets(500);

io.on('connection', (socket) => {
  const player = {
    id: socket.id,
    x: Math.random() * WORLD_SIZE,
    y: Math.random() * WORLD_SIZE,
    radius: INITIAL_RADIUS,
    color: `hsl(${Math.random() * 360}, 70%, 50%)`,
    name: `Whale ${socket.id.substring(0, 4)}`,
    wallet: null as string | null,
  };
  players.set(socket.id, player);

  socket.emit('init', { id: socket.id, players: Array.from(players.values()), pellets: Array.from(pellets.values()) });

  socket.on('input', (data: { dx: number, dy: number }) => {
    const p = players.get(socket.id);
    if (!p) return;
    const angle = Math.atan2(data.dy, data.dx);
    const speed = Math.max(1, 5 - (p.radius / 100));
    p.x += Math.cos(angle) * speed;
    p.y += Math.sin(angle) * speed;
    p.x = Math.max(0, Math.min(WORLD_SIZE, p.x));
    p.y = Math.max(0, Math.min(WORLD_SIZE, p.y));
  });

  socket.on('linkWallet', async (wallet: string) => {
    const p = players.get(socket.id);
    if (!p) return;

    // VERIFICATION: Only allow linking if they hold the coin
    const holdsCoin = await verifyCoinHolding(wallet);
    if (holdsCoin) {
      p.wallet = wallet;
      socket.emit('walletLinked', { success: true });
    } else {
      socket.emit('walletLinked', { success: false, reason: 'You must hold the community coin to be eligible for rewards!' });
    }
  });

  socket.on('disconnect', () => {
    players.delete(socket.id);
    io.emit('playerDisconnected', socket.id);
  });
});

setInterval(async () => {
  // 1. Pellets
  players.forEach(p => {
    pellets.forEach(pellet => {
      if (Math.hypot(p.x - pellet.x, p.y - pellet.y) < p.radius + 5) {
        p.radius += 0.2;
        pellet.x = Math.random() * WORLD_SIZE;
        pellet.y = Math.random() * WORLD_SIZE;
      }
    });
  });

  // 2. PvP
  const playerList = Array.from(players.values());
  for (let i = 0; i < playerList.length; i++) {
    for (let j = 0; j < playerList.length; j++) {
      if (i === j) continue;
      const p1 = playerList[i];
      const p2 = playerList[j];
      if (Math.hypot(p1.x - p2.x, p1.y - p2.y) < p1.radius && p1.radius > p2.radius * 1.1) {
        p1.radius += p2.radius * 0.5;
        p2.radius = INITIAL_RADIUS;
        p2.x = Math.random() * WORLD_SIZE;
        p2.y = Math.random() * WORLD_SIZE;
      }
    }
  }

  // 3. Round Timing
  const elapsed = (Date.now() - roundStartTime) / 1000;
  const timeLeft = Math.max(0, ROUND_DURATION - elapsed);

  if (timeLeft <= 0) {
    const winner = playerList.sort((a, b) => b.radius - a.radius)[0];

    // Persist Round
    const res = await pgPool.query(
      'INSERT INTO rounds (start_time, winner_id, reward) VALUES ($1, $2, $3) RETURNING id',
      [new Date(roundStartTime), winner?.id, rewardPool]
    );
    const roundDbId = res.rows[0].id;

    // If winner has a verified wallet, queue payout
    if (winner && winner.wallet) {
      await pgPool.query(
        'INSERT INTO payouts (round_id, wallet, amount) VALUES ($1, $2, $3)',
        [roundDbId, winner.wallet, rewardPool]
      );
    }

    io.emit('roundEnd', {
      winner: winner ? { name: winner.name, radius: winner.radius } : null,
      reward: rewardPool,
      roundId: currentRoundId
    });

    roundStartTime = Date.now();
    currentRoundId++;
  }

  io.emit('state', {
    players: Array.from(players.values()),
    pellets: Array.from(pellets.values()),
    round: { timeLeft: Math.floor(timeLeft), rewardPool, roundId: currentRoundId }
  });
}, 15);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Game server running on port ${PORT}`));
