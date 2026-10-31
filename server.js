const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 静态文件
app.use(express.static('public'));

// 房间存储：roomCode -> roomData
const rooms = new Map();

// 生成6位房间码
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混淆字符
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// 创建房间
function createRoom(thinkTime = 60) {
  const code = generateRoomCode();
  const room = {
    code,
    players: [],        // 最多2人
    currentRound: 1,
    thinkTime,
    roundData: {},      // { roundNum: { player1: {word, submitted}, player2: {...} } }
    status: 'waiting',  // waiting | playing | finished
    timer: null
  };
  rooms.set(code, room);
  return room;
}

// 广播给房间内所有人
function broadcast(room, message) {
  room.players.forEach(p => {
    if (p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(JSON.stringify(message));
    }
  });
}

// 检查本轮是否两人都提交了
function checkRoundComplete(room) {
  const round = room.roundData[room.currentRound];
  if (!round) return;

  const allSubmitted = room.players.every(p => round[p.id]?.submitted);
  
  if (allSubmitted) {
    // 取消计时器
    if (room.timer) {
      clearTimeout(room.timer);
      room.timer = null;
    }

    const words = room.players.map(p => round[p.id].word);
    const isMatch = words[0] === words[1];

    // 广播结果
    broadcast(room, {
      type: 'round_result',
      round: room.currentRound,
      words: room.players.map(p => ({
        playerId: p.id,
        nickname: p.nickname,
        word: round[p.id].word
      })),
      match: isMatch,
      totalRounds: room.currentRound
    });

    if (isMatch) {
      room.status = 'finished';
    } else {
      room.currentRound++;
      startNewRound(room);
    }
  }
}

// 开始新一轮
function startNewRound(room) {
  room.roundData[room.currentRound] = {};
  
  // 初始化本轮数据
  room.players.forEach(p => {
    room.roundData[room.currentRound][p.id] = { word: '', submitted: false };
  });

  // 广播新一轮开始
  broadcast(room, {
    type: 'new_round',
    round: room.currentRound,
    thinkTime: room.thinkTime,
    history: getHistory(room)
  });

  // 设置超时（时间到自动判负/继续）
  room.timer = setTimeout(() => {
    broadcast(room, {
      type: 'time_up',
      round: room.currentRound,
      message: '时间到！本轮作废，进入下一轮'
    });
    room.currentRound++;
    startNewRound(room);
  }, room.thinkTime * 1000);
}

// 获取历史记录
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

// WebSocket 连接处理
wss.on('connection', (ws) => {
  let currentRoom = null;
  let playerId = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      
      switch (msg.type) {
        case 'create_room':
          const room = createRoom(msg.thinkTime || 60);
          playerId = 'player_' + Date.now();
          room.players.push({
            id: playerId,
            nickname: msg.nickname || '玩家1',
            ws
          });
          currentRoom = room;
          ws.send(JSON.stringify({
            type: 'room_created',
            roomCode: room.code,
            playerId,
            thinkTime: room.thinkTime
          }));
          break;

        case 'join_room':
          const joinRoom = rooms.get(msg.roomCode);
          if (!joinRoom) {
            ws.send(JSON.stringify({ type: 'error', message: '我不认识这个码...请重新输入' }));
            return;
          }
          if (joinRoom.players.length >= 2) {
            ws.send(JSON.stringify({ type: 'error', message: '房间满人喽...' }));
            return;
          }
          playerId = 'player_' + Date.now();
          joinRoom.players.push({
            id: playerId,
            nickname: msg.nickname || '玩家2',
            ws
          });
          currentRoom = joinRoom;

          ws.send(JSON.stringify({
            type: 'joined_room',
            roomCode: joinRoom.code,
            playerId,
            thinkTime: joinRoom.thinkTime,
            opponent: joinRoom.players[0].nickname
          }));

          // 通知房主有人加入
          broadcast(joinRoom, {
            type: 'player_joined',
            nickname: msg.nickname,
            message: `${msg.nickname} 加入房间啦！`
          });

          // 人齐了，开始游戏
          if (joinRoom.players.length === 2) {
            joinRoom.status = 'playing';
            setTimeout(() => startNewRound(joinRoom), 1000);
          }
          break;

        case 'submit_word':
          if (!currentRoom || currentRoom.status !== 'playing') return;
          
          const round = currentRoom.roundData[currentRoom.currentRound];
          if (round && round[playerId]) {
            round[playerId].word = msg.word.trim();
            round[playerId].submitted = true;

            // 通知对方已提交（不显示词）
            broadcast(currentRoom, {
              type: 'opponent_submitted',
              round: currentRoom.currentRound
            });

            checkRoundComplete(currentRoom);
          }
          break;

        case 'get_history':
          if (currentRoom) {
            ws.send(JSON.stringify({
              type: 'history',
              history: getHistory(currentRoom),
              currentRound: currentRoom.currentRound
            }));
          }
          break;
      }
    } catch (e) {
      console.error('消息解析错误:', e);
    }
  });

  ws.on('close', () => {
    if (currentRoom && playerId) {
      currentRoom.players = currentRoom.players.filter(p => p.id !== playerId);
      
      if (currentRoom.players.length === 0) {
        // 房间没人了，销毁
        if (currentRoom.timer) clearTimeout(currentRoom.timer);
        rooms.delete(currentRoom.code);
      } else {
        // 通知对方离开
        broadcast(currentRoom, {
          type: 'player_left',
          message: '对方已离开'
        });
        currentRoom.status = 'waiting';
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`同词相遇服务器运行在端口 ${PORT}`);
});