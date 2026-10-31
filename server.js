const express = require('express');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.static('public'));

// 房间存储
const rooms = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function createRoom(thinkTime = 60) {
  const code = generateRoomCode();
  const room = {
    code,
    players: [],
    currentRound: 1,
    thinkTime,
    roundData: {},
    status: 'waiting',
    lastActivity: Date.now()
  };
  rooms.set(code, room);
  return room;
}

function getHistory(room) {
  const history = [];
  for (let i = 1; i < room.currentRound; i++) {
    const round = room.roundData[i];
    if (round) {
      history.push({
        round: i,
        words: room.players.map(p => ({
          nickname: p.nickname,
          word: round[p.id]?.word || '(未提交)'
        }))
      });
    }
  }
  return history;
}

function checkRoundComplete(room) {
  const round = room.roundData[room.currentRound];
  if (!round) return;

  const allSubmitted = room.players.every(p => round[p.id]?.submitted);
  
  if (allSubmitted) {
    const words = room.players.map(p => round[p.id].word);
    const isMatch = words[0] === words[1];

    const result = {
      type: 'round_result',
      round: room.currentRound,
      words: room.players.map(p => ({
        playerId: p.id,
        nickname: p.nickname,
        word: round[p.id].word
      })),
      match: isMatch,
      totalRounds: room.currentRound,
      history: getHistory(room)
    };

    if (isMatch) {
      room.status = 'finished';
    } else {
      room.currentRound++;
      startNewRound(room);
    }

    return result;
  }
  return null;
}

function startNewRound(room) {
  room.roundData[room.currentRound] = {};
  room.players.forEach(p => {
    room.roundData[room.currentRound][p.id] = { word: '', submitted: false };
  });
  room.lastActivity = Date.now();
}

// API 路由

// 创建房间
app.post('/api/create-room', (req, res) => {
  const { nickname, thinkTime } = req.body;
  const room = createRoom(thinkTime || 60);
  const playerId = 'player_' + Date.now();
  
  room.players.push({
    id: playerId,
    nickname: nickname || '玩家1'
  });

  res.json({
    type: 'room_created',
    roomCode: room.code,
    playerId,
    thinkTime: room.thinkTime
  });
});

// 加入房间
app.post('/api/join-room', (req, res) => {
  const { roomCode, nickname } = req.body;
  const room = rooms.get(roomCode);

  if (!room) {
    return res.json({ type: 'error', message: '房间不存在' });
  }
  if (room.players.length >= 2) {
    return res.json({ type: 'error', message: '房间已满' });
  }

  const playerId = 'player_' + Date.now();
  room.players.push({
    id: playerId,
    nickname: nickname || '玩家2'
  });

  // 人齐了，开始游戏
  if (room.players.length === 2) {
    room.status = 'playing';
    startNewRound(room);
  }

  res.json({
    type: 'joined_room',
    roomCode: room.code,
    playerId,
    thinkTime: room.thinkTime,
    opponent: room.players[0].nickname,
    status: room.status
  });
});

// 提交词
app.post('/api/submit-word', (req, res) => {
  const { roomCode, playerId, word } = req.body;
  const room = rooms.get(roomCode);

  if (!room || room.status !== 'playing') {
    return res.json({ type: 'error', message: '游戏未在进行' });
  }

  const round = room.roundData[room.currentRound];
  if (round && round[playerId]) {
    round[playerId].word = word.trim();
    round[playerId].submitted = true;
    room.lastActivity = Date.now();

    const result = checkRoundComplete(room);
    if (result) {
      return res.json({ type: 'round_result', ...result });
    }

    return res.json({ type: 'submitted', round: room.currentRound });
  }

  res.json({ type: 'error', message: '提交失败' });
});

// 轮询获取状态
app.get('/api/game-state', (req, res) => {
  const { roomCode, playerId } = req.query;
  const room = rooms.get(roomCode);

  if (!room) {
    return res.json({ type: 'error', message: '房间不存在' });
  }

  const round = room.roundData[room.currentRound];
  const mySubmitted = round?.[playerId]?.submitted || false;
  const opponentSubmitted = room.players.length === 2 && round?.[room.players.find(p => p.id !== playerId)?.id]?.submitted || false;

  // 检查是否双方都提交了（用于轮询方获取结果）
  let roundResult = null;
  if (room.players.length === 2 && round) {
    const allSubmitted = room.players.every(p => round[p.id]?.submitted);
    if (allSubmitted) {
      const words = room.players.map(p => round[p.id].word);
      const isMatch = words[0] === words[1];
      roundResult = {
        round: room.currentRound,
        words: room.players.map(p => ({
          playerId: p.id,
          nickname: p.nickname,
          word: round[p.id].word
        })),
        match: isMatch,
        totalRounds: room.currentRound
      };
    }
  }

  res.json({
    type: 'game_state',
    status: room.status,
    currentRound: room.currentRound,
    thinkTime: room.thinkTime,
    mySubmitted,
    opponentSubmitted,
    players: room.players.map(p => ({ id: p.id, nickname: p.nickname })),
    roundResult,
    history: getHistory(room)
  });
});

// 清理过期房间（30分钟无活动）
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (now - room.lastActivity > 30 * 60 * 1000) {
      rooms.delete(code);
    }
  }
}, 5 * 60 * 1000);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`同词相遇服务器运行在端口 ${PORT}`);
});