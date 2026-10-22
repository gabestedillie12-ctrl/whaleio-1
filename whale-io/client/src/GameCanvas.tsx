import React, { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';

interface Point {
  x: number;
  y: number;
}

interface Entity {
  x: number;
  y: number;
  radius: number;
  color: string;
  id: string;
  name?: string;
  wallet?: string | null;
}

interface RoundState {
  timeLeft: number;
  rewardPool: number;
  roundId: number;
}

const WORLD_SIZE = 5000;
const INITIAL_RADIUS = 20;

const socket: Socket = io('http://localhost:3001');

const GameCanvas: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [myId, setMyId] = useState<string | null>(null);
  const myIdRef = useRef<string | null>(null);
  const [mass, setMass] = useState(INITIAL_RADIUS);
  const [round, setRound] = useState<RoundState | null>(null);
  const [leaderboard, setLeaderboard] = useState<{name: string, radius: number}[]>([]);
  const [winnerPopup, setWinnerPopup] = useState<string | null>(null);
  const [wallet, setWallet] = useState<string>('');
  const [isLinking, setIsLinking] = useState(false);
  const [linkStatus, setLinkStatus] = useState<{success: boolean, message?: string} | null>(null);

  const playersRef = useRef<Map<string, Entity>>(new Map());
  const pelletsRef = useRef<Entity[]>([]);
  const mouseRef = useRef<Point>({ x: 0, y: 0 });

  useEffect(() => {
    socket.on('init', (data: { id: string, players: Entity[], pellets: Entity[] }) => {
      setMyId(data.id);
      myIdRef.current = data.id;
      data.players.forEach(p => playersRef.current.set(p.id, p));
      pelletsRef.current = data.pellets;
    });

    socket.on('state', (data: { players: Entity[], pellets: Entity[], round: RoundState }) => {
      data.players.forEach(p => playersRef.current.set(p.id, p));
      pelletsRef.current = data.pellets;
      setRound(data.round);

      const me = data.players.find(p => p.id === myIdRef.current);
      if (me) setMass(me.radius);

      const top = [...data.players]
        .sort((a, b) => b.radius - a.radius)
        .slice(0, 10)
        .map(p => ({ name: p.name || 'Whale', radius: p.radius }));
      setLeaderboard(top);
    });

    socket.on('roundEnd', (data: { winner: {name: string, radius: number} | null, reward: number, roundId: number }) => {
      if (data.winner) {
        setWinnerPopup(`Round ${data.roundId} Winner: ${data.winner.name} with ${Math.floor(data.winner.radius)} mass! Reward: ${data.reward} SOL`);
        setTimeout(() => setWinnerPopup(null), 5000);
      }
    });

    socket.on('walletLinked', (data: { success: boolean, reason?: string }) => {
      setIsLinking(false);
      setLinkStatus({ success: data.success, message: data.reason });
      setTimeout(() => setLinkStatus(null), 5000);
    });

    socket.on('playerDisconnected', (id: string) => {
      playersRef.current.delete(id);
    });

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;
    const render = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      const me = playersRef.current.get(myIdRef.current || '');
      if (!me) {
        animationFrameId = requestAnimationFrame(render);
        return;
      }

      const zoom = Math.max(0.2, 1 - (me.radius - INITIAL_RADIUS) / 1000);
      ctx.save();
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.scale(zoom, zoom);
      ctx.translate(-me.x, -me.y);

      ctx.strokeStyle = '#333';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= WORLD_SIZE; x += 100) { ctx.moveTo(x, 0); ctx.lineTo(x, WORLD_SIZE); }
      for (let y = 0; y <= WORLD_SIZE; y += 100) { ctx.moveTo(0, y); ctx.lineTo(WORLD_SIZE, y); }
      ctx.stroke();

      pelletsRef.current.forEach(p => {
        ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI * 2); ctx.fill();
      });

      playersRef.current.forEach(p => {
        ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'white';
        ctx.font = 'bold 16px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(p.name || 'Whale', p.x, p.y + 6);
      });

      ctx.restore();
      animationFrameId = requestAnimationFrame(render);
    };

    render();
    return () => {
      cancelAnimationFrame(animationFrameId);
      socket.off('init'); socket.off('state'); socket.off('roundEnd'); socket.off('playerDisconnected'); socket.off('walletLinked');
    };
  }, []);

  const handleLinkWallet = () => {
    if (!wallet) return;
    setIsLinking(true);
    socket.emit('linkWallet', wallet);
  };

  return (
    <div style={{ width: '100vw', height: '100vh', overflow: 'hidden', background: '#1a1a1a', color: 'white', fontFamily: 'Arial' }}>
      {/* HUD */}
      <div style={{ position: 'absolute', top: 20, left: 20, zIndex: 10, pointerEvents: 'none' }}>
        <div style={{ fontSize: '24px', fontWeight: 'bold' }}>Mass: {Math.floor(mass)}</div>
        <div style={{ fontSize: '18px', opacity: 0.8 }}>
          Round: {round?.roundId} | Time: {round?.timeLeft}s | Pool: {round?.rewardPool} SOL
        </div>
      </div>

      {/* Wallet Integration */}
      <div style={{
        position: 'absolute',
        bottom: 20,
        left: 20,
        zIndex: 10,
        background: 'rgba(0,0,0,0.7)',
        padding: '15px',
        borderRadius: '10px',
        display: 'flex',
        gap: '10px',
        alignItems: 'center'
      }}>
        <input
          type="text"
          placeholder="Solana Wallet Address"
          value={wallet}
          onChange={(e) => setWallet(e.target.value)}
          style={{ padding: '8px', borderRadius: '5px', border: 'none', width: '250px' }}
        />
        <button
          onClick={handleLinkWallet}
          disabled={isLinking}
          style={{ padding: '8px 15px', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold' }}
        >
          {isLinking ? 'Verifying...' : 'Link Wallet'}
        </button>
        {linkStatus && (
          <span style={{ color: linkStatus.success ? 'lime' : 'red', fontSize: '14px' }}>
            {linkStatus.message || (linkStatus.success ? 'Wallet Linked!' : 'Link Failed')}
          </span>
        )}
      </div>

      {/* Leaderboard */}
      <div style={{
        position: 'absolute',
        top: 20,
        right: 20,
        zIndex: 10,
        background: 'rgba(0,0,0,0.5)',
        padding: '15px',
        borderRadius: '10px',
        minWidth: '200px',
        pointerEvents: 'none'
      }}>
        <div style={{ fontSize: '20px', fontWeight: 'bold', marginBottom: '10px', textAlign: 'center' }}>Leaderboard</div>
        {leaderboard.map((p, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '5px' }}>
            <span>{i + 1}. {p.name}</span>
            <span>{Math.floor(p.radius)}</span>
          </div>
        ))}
      </div>

      {winnerPopup && (
        <div style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          background: 'rgba(0,0,0,0.9)',
          color: 'gold',
          padding: '40px',
          borderRadius: '20px',
          fontSize: '32px',
          fontWeight: 'bold',
          textAlign: 'center',
          zIndex: 100,
          border: '4px solid gold'
        }}>
          {winnerPopup}
        </div>
      )}

      <canvas
        ref={canvasRef}
        onMouseMove={(e) => {
          mouseRef.current = { x: e.clientX, y: e.clientY };
          const dx = e.clientX - window.innerWidth / 2;
          const dy = e.clientY - window.innerHeight / 2;
          socket.emit('input', { dx, dy });
        }}
        style={{ display: 'block' }}
      />
    </div>
  );
};

export default GameCanvas;
