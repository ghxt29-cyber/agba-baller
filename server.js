// ============================================
// AGBA BALLER - Phase 1 Core Game Server
// ============================================
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

// --- INITIALISE EXPRESS & SOCKET.IO ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- INITIALISE SUPABASE CONNECTION ---
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

// --- SERVE GAME CLIENT (HTML file) ---
app.use(express.static(path.join(__dirname, 'public')));

// --- IN-MEMORY ROOM STORE ---
// Holds active match lobbies while server is running
const activeRooms = {};

// ============================================
// SOCKET.IO EVENT HANDLERS
// ============================================
io.on('connection', (socket) => {
    console.log(`✅ Player connected: ${socket.id}`);

    // --- CREATE A STREET TEAM LOBBY ---
    socket.on('create_street_team', async (data) => {
        // Sanitise inputs - never trust what comes from the browser
        const cleanTeamName = String(data.teamName).replace(/[<>'"]/g, "").trim();
        const cleanUsername = String(data.username).replace(/[<>'"]/g, "").trim();

        if (!cleanTeamName || !cleanUsername) {
            socket.emit('error_message', { msg: 'Team name and username cannot be empty.' });
            return;
        }

        // Generate a unique 6-character invite code
        const inviteCode = Math.random().toString(36).substring(2, 8).toUpperCase();

        // Store the room in memory
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

        // Save team to Supabase database
        const { error } = await supabase.from('teams').insert({
            team_name: cleanTeamName,
            invite_code: inviteCode,
            escrow_stake_balance: 0
        });

        if (error) {
            console.error('Supabase team save error:', error.message);
        }

        // Send confirmation back to the captain
        socket.emit('team_created', {
            inviteCode,
            teamName: cleanTeamName,
            players: activeRooms[inviteCode].players
        });

        console.log(`🏟️  Team created: ${cleanTeamName} | Code: ${inviteCode}`);
    });

    // --- JOIN AN EXISTING TEAM LOBBY ---
    socket.on('join_street_team', (data) => {
        const cleanCode = String(data.inviteCode).replace(/[^A-Z0-9]/g, "").toUpperCase();
        const cleanUsername = String(data.username).replace(/[<>'"]/g, "").trim();
        const room = activeRooms[cleanCode];

        if (!room) {
            socket.emit('error_message', { msg: 'Invite code not found. Check the code and try again.' });
            return;
        }

        if (room.players.length >= room.maxPlayers) {
            socket.emit('error_message', { msg: 'This team is already full (5 players max).' });
            return;
        }

        // Add player to the room
        room.players.push({
            socketId: socket.id,
            username: cleanUsername,
            role: 'Player'
        });

        socket.join(cleanCode);

        // Tell everyone in the room that a new player joined
        io.to(cleanCode).emit('player_joined', {
            username: cleanUsername,
            players: room.players,
            teamName: room.teamName
        });

        console.log(`⚽ ${cleanUsername} joined team: ${room.teamName}`);
    });

    // --- E2EE CHAT MESSAGE RELAY ---
    // Server ONLY forwards the encrypted packet - it cannot read the content
    socket.on('relay_encrypted_packet', (payload) => {
        const { targetSocketId, senderUsername, cipherText, payloadType } = payload;
        io.to(targetSocketId).emit('receive_encrypted_packet', {
            sender: senderUsername,
            cipherText: cipherText,
            payloadType: payloadType,
            timestamp: new Date().toLocaleTimeString()
        });
    });

    // --- WEBRTC CALL SIGNALING ---
    // Server only passes the signal - actual call is peer-to-peer
    socket.on('call_signal_exchange', (payload) => {
        const { targetSocketId, signalData, sender } = payload;
        io.to(targetSocketId).emit('incoming_call_signal', {
            sender: sender,
            signalData: signalData,
            fromSocketId: socket.id
        });
    });

    // --- HANDLE PLAYER DISCONNECT ---
    socket.on('disconnect', () => {
        console.log(`❌ Player disconnected: ${socket.id}`);
        // Remove player from any room they were in
        for (const code in activeRooms) {
            const room = activeRooms[code];
            room.players = room.players.filter(p => p.socketId !== socket.id);
            // Clean up empty rooms
            if (room.players.length === 0) {
                delete activeRooms[code];
                console.log(`🗑️  Empty room removed: ${code}`);
            }
        }
    });
});

// --- START THE SERVER ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 AGBA BALLER Server running on port ${PORT}`);
    console.log(`🔒 Supabase connected: ${process.env.SUPABASE_URL}`);
});