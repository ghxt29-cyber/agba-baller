// ============================================
// AGBA BALLER - Phase 2 Game Server
// ============================================
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.json());

// --- SUPABASE CLIENTS ---
// Public client — for normal player actions
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

// Admin client — for server-side auth (bypasses rate limits)
const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// --- SERVE STATIC FILES ---
app.use(express.static(path.join(__dirname, 'public')));

// --- PUBLIC CONFIG ENDPOINT ---
app.get('/api/config', (req, res) => {
    res.json({
        supabaseUrl: process.env.SUPABASE_URL,
        supabaseAnonKey: process.env.SUPABASE_ANON_KEY
    });
});

// ============================================
// AUTH ENDPOINTS
// ============================================

// SIGNUP — handled server-side to bypass rate limits
app.post('/api/signup', async (req, res) => {
    const { email, password, username, homeState, homeLga, homeStreet } = req.body;

    // Validate inputs
    if (!email || !password || !username || !homeState || !homeLga || !homeStreet) {
        return res.json({ success: false, message: 'All fields are required.' });
    }
    if (password.length < 6) {
        return res.json({ success: false, message: 'Password must be at least 6 characters.' });
    }
    if (username.length < 3) {
        return res.json({ success: false, message: 'Baller name must be at least 3 characters.' });
    }

    // Sanitise inputs
    const cleanUsername = String(username).replace(/[<>'"]/g, '').trim();
    const cleanState    = String(homeState).replace(/[<>'"]/g, '').trim();
    const cleanLga      = String(homeLga).replace(/[<>'"]/g, '').trim();
    const cleanStreet   = String(homeStreet).replace(/[<>'"]/g, '').trim();

    try {
        // Step 1 — Create auth user using admin client
        const { data: authData, error: authError } =
            await supabaseAdmin.auth.admin.createUser({
                email,
                password,
                email_confirm: true // auto-confirm, no email needed
            });

        if (authError) {
            console.error('Auth error:', authError.message);
            return res.json({ success: false, message: authError.message });
        }

        // Step 2 — Create player profile
        const { error: profileError } = await supabaseAdmin
            .from('players')
            .insert({
                user_id:      authData.user.id,
                username:     cleanUsername,
                home_state:   cleanState,
                home_lga:     cleanLga,
                home_street:  cleanStreet,
                naira_balance: 100000,
                stamina:      100
            });

        if (profileError) {
            console.error('Profile error:', profileError.message);
            return res.json({ success: false, message: profileError.message });
        }

                console.log(`✅ New baller created: ${cleanUsername} from ${cleanState}`);
        return res.json({
            success: true,
            message: `Baller "${cleanUsername}" created! Starting balance: ₦100,000`
        });

    } catch (err) {
        console.error('Signup error:', err);
        return res.json({ success: false, message: 'Server error. Try again.' });
    }
});

// ============================================
// IN-MEMORY ROOM STORE
// ============================================
const activeRooms = {};

// ============================================
// SOCKET.IO EVENT HANDLERS
// ============================================
io.on('connection', (socket) => {
    console.log(`✅ Player connected: ${socket.id}`);

    // --- CREATE A STREET TEAM LOBBY ---
    socket.on('create_street_team', async (data) => {
        const cleanTeamName = String(data.teamName).replace(/[<>'"]/g, '').trim();
        const cleanUsername = String(data.username).replace(/[<>'"]/g, '').trim();

        if (!cleanTeamName || !cleanUsername) {
            socket.emit('error_message', { msg: 'Team name and username cannot be empty.' });
            return;
        }

        const inviteCode = Math.random().toString(36).substring(2, 8).toUpperCase();

        activeRooms[inviteCode] = {
            teamName: cleanTeamName,
            players: [{
                socketId: socket.id,
                username: cleanUsername,
                role: 'Captain'
            }],
            maxPlayers: 5
        };

        socket.join(inviteCode);

        const { error } = await supabase.from('teams').insert({
            team_name: cleanTeamName,
            invite_code: inviteCode,
            escrow_stake_balance: 0
        });

        if (error) {
            console.error('Supabase team save error:', error.message);
        }

        socket.emit('team_created', {
            inviteCode,
            teamName: cleanTeamName,
            players: activeRooms[inviteCode].players
        });

        console.log(`🏟️ Team created: ${cleanTeamName} | Code: ${inviteCode}`);
    });

    // --- JOIN AN EXISTING TEAM LOBBY ---
    socket.on('join_street_team', (data) => {
        const cleanCode     = String(data.inviteCode).replace(/[^A-Z0-9]/g, '').toUpperCase();
        const cleanUsername = String(data.username).replace(/[<>'"]/g, '').trim();
        const room = activeRooms[cleanCode];

        if (!room) {
            socket.emit('error_message', { msg: 'Invite code not found. Check the code and try again.' });
            return;
        }
        if (room.players.length >= room.maxPlayers) {
            socket.emit('error_message', { msg: 'This team is already full (5 players max).' });
            return;
        }

        room.players.push({
            socketId: socket.id,
            username: cleanUsername,
            role: 'Player'
        });

        socket.join(cleanCode);

        io.to(cleanCode).emit('player_joined', {
            username: cleanUsername,
            players: room.players,
            teamName: room.teamName
        });

        console.log(`⚽ ${cleanUsername} joined team: ${room.teamName}`);
    });

    // --- PLAYER MOVEMENT BROADCAST ---
    socket.on('player_move', (data) => {
        for (const code in activeRooms) {
            const room = activeRooms[code];
            const player = room.players.find(p => p.socketId === socket.id);
            if (player) {
                player.x = data.x;
                player.y = data.y;
                player.username = data.username;
                player.isHome = data.isHome;
                const positions = {};
                room.players.forEach(p => {
                    positions[p.socketId] = {
                        x: p.x || 375,
                        y: p.y || 210,
                        username: p.username,
                        isHome: p.isHome
                    };
                });
                io.to(code).emit('player_positions', positions);
                break;
            }
        }
    });

    // --- E2EE CHAT RELAY ---
    socket.on('relay_encrypted_packet', (payload) => {
        const { targetSocketId, senderUsername, cipherText, payloadType } = payload;
        io.to(targetSocketId).emit('receive_encrypted_packet', {
            sender: senderUsername,
            cipherText: cipherText,
            payloadType: payloadType,
            timestamp: new Date().toLocaleTimeString()
        });
    });

    // --- WEBRTC SIGNALING ---
    socket.on('call_signal_exchange', (payload) => {
        const { targetSocketId, signalData, sender } = payload;
        io.to(targetSocketId).emit('incoming_call_signal', {
            sender,
            signalData,
            fromSocketId: socket.id
        });
    });

    // --- DISCONNECT ---
    socket.on('disconnect', () => {
        console.log(`❌ Player disconnected: ${socket.id}`);
        for (const code in activeRooms) {
            const room = activeRooms[code];
            room.players = room.players.filter(p => p.socketId !== socket.id);
            if (room.players.length === 0) {
                delete activeRooms[code];
                console.log(`🗑️ Empty room removed: ${code}`);
            }
        }
    });
});

// --- START SERVER ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 AGBA BALLER Server running on port ${PORT}`);
    console.log(`🔒 Supabase connected: ${process.env.SUPABASE_URL}`);
});