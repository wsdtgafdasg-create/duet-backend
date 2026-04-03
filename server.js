const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
require('dotenv').config();
const { getAudioUrl } = require('./utils/audio');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
});

app.use(cors());
app.use(express.json());

// ─── In-memory store ───────────────────────────────────────────────
const rooms = new Map();

// ─── Helpers ───────────────────────────────────────────────────────
function generateRoomCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function extractVideoId(url) { 
  if (!url) return null;
  const patterns = [
    /youtu\.be\/([^?&]+)/,
    /youtube\.com\/watch\?.*v=([^&]+)/,
    /youtube\.com\/embed\/([^/?]+)/,
    /youtube\.com\/shorts\/([^?&]+)/,
    /youtube\.com\/v\/([^/?]+)/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  try {
    return new URL(url).searchParams.get('v');
  } catch {
    return null;
  }
}

async function fetchYouTubeMetadata(videoId) {
  // Use oEmbed — free, no API key, returns title + author
  const res = await fetch(
    `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`
  );
  if (!res.ok) throw new Error('Video not found or not embeddable');
  const data = await res.json();
  return {
    title: data.title,
    artist: data.author_name,
    thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
    videoId,
  };
}

// ─── REST API ──────────────────────────────────────────────────────

// Health check
app.get('/api/health', (_, res) => res.json({ status: 'ok' }));

// Create room
app.post('/api/rooms/create', (req, res) => {
  const { hostName, hostAvatar, roomName } = req.body;
  if (!hostName) return res.status(400).json({ success: false, error: 'hostName required' });

  const roomCode = generateRoomCode();
  const hostUser = { id: `user_${Date.now()}`, name: hostName, avatar: hostAvatar || '🎵', isHost: true };

  const room = {
    id: roomCode,
    name: roomName || `${hostName}'s Jam`,
    host: hostUser,
    createdAt: Date.now(),
    isPlaying: false,
    currentSong: null,
    currentTime: 0,
    lastSyncAt: Date.now(),
    queue: [],
    users: [hostUser],
    chat: [],
  };

  rooms.set(roomCode, room);
  console.log(`✅ Room created: ${roomCode} by ${hostName}`);
  res.json({ success: true, roomCode, room });
});

// Join room
app.post('/api/rooms/join', (req, res) => {
  const { roomCode, userName, userAvatar } = req.body;
  const room = rooms.get(roomCode);
  if (!room) return res.status(404).json({ success: false, error: 'Room not found' });

  // Check if username taken
  const nameTaken = room.users.some(u => u.name.toLowerCase() === userName?.toLowerCase());
  if (nameTaken) return res.status(409).json({ success: false, error: 'Name already taken in this room' });

  const newUser = { id: `user_${Date.now()}`, name: userName, avatar: userAvatar || '🎵', isHost: false };
  room.users.push(newUser);
  rooms.set(roomCode, room);

  console.log(`👤 ${userName} joined room: ${roomCode}`);
  res.json({ success: true, room, user: newUser });
});

// Get room info
app.get('/api/rooms/:roomCode', (req, res) => {
  const room = rooms.get(req.params.roomCode);
  if (!room) return res.status(404).json({ success: false, error: 'Room not found' });
  res.json({ success: true, room });
});

// Add song (no audio extraction — just metadata via oEmbed)
app.post('/api/rooms/:roomCode/add-song', async (req, res) => {
  const { roomCode } = req.params;
  const { youtubeUrl, addedBy, addedByName } = req.body;

  const room = rooms.get(roomCode);
  if (!room) return res.status(404).json({ success: false, error: 'Room not found' });
  if (!youtubeUrl) return res.status(400).json({ success: false, error: 'YouTube URL required' });

  const videoId = extractVideoId(youtubeUrl);
  if (!videoId) return res.status(400).json({ success: false, error: 'Invalid YouTube URL' });

  // Check duplicate in queue
  const isDuplicate =
    room.queue.some(s => s.videoId === videoId) ||
    room.currentSong?.videoId === videoId;
  if (isDuplicate) return res.status(409).json({ success: false, error: 'Song already in queue' });

  try {
    const meta = await fetchYouTubeMetadata(videoId);
    const song = {
      id: `song_${Date.now()}`,
      videoId: meta.videoId,
      youtubeUrl: `https://www.youtube.com/watch?v=${videoId}`,
      embedUrl: `https://www.youtube.com/embed/${videoId}?autoplay=1`,  // Add this
      title: meta.title,
      artist: meta.artist,
      thumbnail: meta.thumbnail,
      addedBy,
      addedByName,
      addedAt: Date.now(),
    };

    if (!room.currentSong) {
      room.currentSong = song;
      room.isPlaying = true;
      room.currentTime = 0;
      room.lastSyncAt = Date.now();
      rooms.set(roomCode, room);

      io.to(roomCode).emit('song-changed', { song: room.currentSong, startTime: 0 });
      io.to(roomCode).emit('queue-updated', room.queue);
      console.log(`🎵 Auto-playing: ${song.title}`);
    } else {
      room.queue.push(song);
      rooms.set(roomCode, room);
      io.to(roomCode).emit('queue-updated', room.queue);
      console.log(`➕ Queued: ${song.title}`);
    }

    res.json({ success: true, song, queue: room.queue, currentSong: room.currentSong });
  } catch (err) {
    console.error('Metadata fetch error:', err.message);
    res.status(400).json({ success: false, error: 'Could not fetch video info. Is it public?' });
  }
});
// ─── Socket.IO ────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`🔌 Connected: ${socket.id}`);

  socket.on('join-room', (roomCode, userId) => {
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.userId = userId;

    const room = rooms.get(roomCode);
    if (room) {
      // Calculate precise current playback time
      let currentTime = room.currentTime;
      if (room.isPlaying && room.lastSyncAt) {
        currentTime += (Date.now() - room.lastSyncAt) / 1000;
      }

      socket.emit('room-state', {
        isPlaying: room.isPlaying,
        currentSong: room.currentSong,
        currentTime,
        queue: room.queue,
        users: room.users,
        chat: room.chat.slice(-50), // last 50 messages
      });
      io.to(roomCode).emit('users-updated', room.users);
    }
  });

  // ── Playback sync (host only) ──
  socket.on('sync-play', (roomCode, currentTime) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    room.isPlaying = true;
    room.currentTime = currentTime ?? room.currentTime;
    room.lastSyncAt = Date.now();
    rooms.set(roomCode, room);
    socket.to(roomCode).emit('force-play', room.currentTime);
  });

  socket.on('sync-pause', (roomCode, currentTime) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    room.isPlaying = false;
    room.currentTime = currentTime ?? room.currentTime;
    room.lastSyncAt = Date.now();
    rooms.set(roomCode, room);
    socket.to(roomCode).emit('force-pause', room.currentTime);
  });

  socket.on('sync-seek', (roomCode, time) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    room.currentTime = time;
    room.lastSyncAt = Date.now();
    rooms.set(roomCode, room);
    socket.to(roomCode).emit('force-seek', time);
  });

  // ── Skip song ──
  socket.on('skip-song', (roomCode) => {
    const room = rooms.get(roomCode);
    if (!room) return;

    if (room.queue.length > 0) {
      room.currentSong = room.queue.shift();
      room.currentTime = 0;
      room.isPlaying = true;
      room.lastSyncAt = Date.now();
      rooms.set(roomCode, room);
      io.to(roomCode).emit('song-changed', { song: room.currentSong, startTime: 0 });
      io.to(roomCode).emit('queue-updated', room.queue);
      console.log(`⏭️ Skipped to: ${room.currentSong.title}`);
    } else {
      room.currentSong = null;
      room.isPlaying = false;
      rooms.set(roomCode, room);
      io.to(roomCode).emit('song-changed', { song: null, startTime: 0 });
      io.to(roomCode).emit('queue-updated', []);
    }
  });

  // ── Song ended (auto-advance) ──
  socket.on('song-ended', (roomCode) => {
    const room = rooms.get(roomCode);
    if (!room) return;

    if (room.queue.length > 0) {
      room.currentSong = room.queue.shift();
      room.currentTime = 0;
      room.isPlaying = true;
      room.lastSyncAt = Date.now();
      rooms.set(roomCode, room);
      io.to(roomCode).emit('song-changed', { song: room.currentSong, startTime: 0 });
      io.to(roomCode).emit('queue-updated', room.queue);
    } else {
      room.currentSong = null;
      room.isPlaying = false;
      rooms.set(roomCode, room);
      io.to(roomCode).emit('song-changed', { song: null, startTime: 0 });
      io.to(roomCode).emit('queue-updated', []);
    }
  });

  // ── Chat ──
  socket.on('send-message', (roomCode, message, user) => {
    const room = rooms.get(roomCode);
    if (!room || !message?.trim()) return;

    const chatMessage = {
      id: `msg_${Date.now()}`,
      userId: user.id,
      userName: user.name,
      userAvatar: user.avatar,
      message: message.trim().slice(0, 500),
      timestamp: Date.now(),
    };
    room.chat.push(chatMessage);
    if (room.chat.length > 200) room.chat = room.chat.slice(-200);
    rooms.set(roomCode, room);
    io.to(roomCode).emit('new-message', chatMessage);
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    if (!socket.roomCode) return;
    const room = rooms.get(socket.roomCode);
    if (!room) return;

    room.users = room.users.filter(u => u.id !== socket.userId);

    if (room.users.length === 0) {
      rooms.delete(socket.roomCode);
      console.log(`🗑️ Room ${socket.roomCode} deleted (empty)`);
    } else {
      if (!room.users.some(u => u.isHost)) {
        room.users[0].isHost = true;
        room.host = { ...room.users[0] };
        io.to(socket.roomCode).emit('new-host', room.users[0]);
        console.log(`👑 New host: ${room.users[0].name}`);
      }
      rooms.set(socket.roomCode, room);
      io.to(socket.roomCode).emit('users-updated', room.users);
    }
    console.log(`🔌 Disconnected: ${socket.id}`);
  });
});

// ─── Start ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`\n🎵 JamVibes backend running on port ${PORT}\n`);
});