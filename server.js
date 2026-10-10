// ============================================
// AGBA BALLER - Phase 2C+ Game Server
// Own Goal Penalty System Added
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
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);
const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// --- SERVE STATIC FILES ---
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// NAIRA REWARD CONFIG
// ============================================
const NAIRA_REWARDS = {
    GOAL:      2500,
    OWN_GOAL_PENALTY: -750,
    WIN:       10000,
    DRAW:      1500,
    LOSS:      0
};

// ============================================
// API ENDPOINTS
// ============================================

app.get('/api/config', (req, res) => {
    res.json({
        supabaseUrl: process.env.SUPABASE_URL,
        supabaseAnonKey: process.env.SUPABASE_ANON_KEY
    });
});

app.post('/api/signup', async (req, res) => {
    const { email, password, username, homeState, homeLga, homeStreet } = req.body;

    if (!email || !password || !username || !homeState || !homeLga || !homeStreet) {
        return res.json({ success: false, message: 'All fields are required.' });
    }
    if (password.length < 6) {
        return res.json({ success: false, message: 'Password must be at least 6 characters.' });
    }
    if (username.length < 3) {
        return res.json({ success: false, message: 'Baller name must be at least 3 characters.' });
    }

    const cleanUsername = String(username).replace(/[<>'"]/g, '').trim();
    const cleanState    = String(homeState).replace(/[<>'"]/g, '').trim();
    const cleanLga      = String(homeLga).replace(/[<>'"]/g, '').trim();
    const cleanStreet   = String(homeStreet).replace(/[<>'"]/g, '').trim();

    try {
        const { data: authData, error: authError } =
            await supabaseAdmin.auth.admin.createUser({
                email, password, email_confirm: true
            });

        if (authError) {
            return res.json({ success: false, message: authError.message });
        }

        const { error: profileError } = await supabaseAdmin
            .from('players')
            .insert({
                user_id:       authData.user.id,
                username:      cleanUsername,
                home_state:    cleanState,
                home_lga:      cleanLga,
                home_street:   cleanStreet,
                naira_balance: 100000,
                stamina:       100
            });

        if (profileError) {
            return res.json({ success: false, message: profileError.message });
        }

        console.log(`✅ New baller created: ${cleanUsername} from ${cleanState}`);
        return res.json({
            success: true,
            message: `Baller "${cleanUsername}" created! Starting balance: ₦100,000`
        });

    } catch (err) {
        return res.json({ success: false, message: 'Server error. Try again.' });
    }
});

app.get('/api/player', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.json({ success: false, message: 'No auth token.' });
    }

    const token = authHeader.replace('Bearer ', '');

    try {
        const { data: { user }, error: authError } =
            await supabaseAdmin.auth.getUser(token);

        if (authError || !user) {
            return res.json({ success: false, message: 'Invalid session.' });
        }

        const { data: player, error: playerError } =
            await supabaseAdmin
                .from('players')
                .select('username, home_state, home_lga, naira_balance, stamina, respect_points, attr_speed, attr_dribbling, attr_shooting')
                .eq('user_id', user.id)
                .single();

        if (playerError || !player) {
            return res.json({ success: false, message: 'Player profile not found.' });
        }

        return res.json({ success: true, player });

    } catch (err) {
        return res.json({ success: false, message: 'Server error.' });
    }
});

// ============================================
// NAIRA TRANSACTION ENGINE
// Handles goals, own goals and match results
// ============================================
async function processNairaTransaction(userId, currentBalance, amount) {
    if (!userId) return null;

    // Never let balance go below zero
    const newBalance = Math.max(0, currentBalance + amount);

    const { error } = await supabaseAdmin
        .from('players')
        .update({ naira_balance: newBalance })
        .eq('user_id', userId);

    if (error) {
        console.error('Naira transaction error:', error.message);
        return null;
    }

    const direction = amount >= 0 ? '+' : '';
    console.log(`💰 Naira transaction: ${direction}₦${amount.toLocaleString()} | New balance: ₦${newBalance.toLocaleString()}`);
    return newBalance;
}

// ============================================
// IN-MEMORY ROOM STORE
// ============================================
const activeRooms = {};

// ============================================
// SOCKET.IO EVENT HANDLERS
// ============================================
io.on('connection', (socket) => {
    console.log(`✅ Player connected: ${socket.id}`);

    // --- CREATE TEAM ---
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
                socketId:     socket.id,
                username:     cleanUsername,
                role:         'Captain',
                userId:       data.userId || null,
                nairaBalance: data.nairaBalance || 100000,
                isHome:       true,
                goals:        0,
                ownGoals:     0
            }],
            maxPlayers:  5,
            homeScore:   0,
            awayScore:   0,
            matchEnded:  false
        };

        socket.join(inviteCode);

        const { error } = await supabase.from('teams').insert({
            team_name:             cleanTeamName,
            invite_code:           inviteCode,
            escrow_stake_balance:  0
        });

        if (error) console.error('Team save error:', error.message);

        socket.emit('team_created', {
            inviteCode,
            teamName: cleanTeamName,
            players:  activeRooms[inviteCode].players
        });

        console.log(`🏟️ Team created: ${cleanTeamName} | Code: ${inviteCode}`);
    });

    // --- JOIN TEAM ---
    socket.on('join_street_team', (data) => {
        const cleanCode     = String(data.inviteCode).replace(/[^A-Z0-9]/g, '').toUpperCase();
        const cleanUsername = String(data.username).replace(/[<>'"]/g, '').trim();
        const room = activeRooms[cleanCode];

        if (!room) {
            socket.emit('error_message', { msg: 'Invite code not found.' });
            return;
        }
        if (room.players.length >= room.maxPlayers) {
            socket.emit('error_message', { msg: 'This team is already full (5 players max).' });
            return;
        }

        room.players.push({
            socketId:     socket.id,
            username:     cleanUsername,
            role:         'Player',
            userId:       data.userId || null,
            nairaBalance: data.nairaBalance || 100000,
            isHome:       false,
            goals:        0,
            ownGoals:     0
        });

        socket.join(cleanCode);

        io.to(cleanCode).emit('player_joined', {
            username: cleanUsername,
            players:  room.players,
            teamName: room.teamName
        });

        console.log(`⚽ ${cleanUsername} joined: ${room.teamName}`);
    });

    // --- GOAL SCORED ---
    // isOwnGoal = true when scorer put it in their own net
    socket.on('goal_scored', async (data) => {
        const { roomCode, scorerSocketId, isHomeGoal, isOwnGoal } = data;
        const room = activeRooms[roomCode];
        if (!room || room.matchEnded) return;

        // Update room score
        if (isHomeGoal) {
            room.homeScore++;
        } else {
            room.awayScore++;
        }

        // Find the player who touched the ball last
        const scorer = room.players.find(p => p.socketId === scorerSocketId);

        if (scorer) {
            let transactionAmount = 0;
            let reason = '';

            if (isOwnGoal) {
                // OWN GOAL — penalise the player
                scorer.ownGoals = (scorer.ownGoals || 0) + 1;
                transactionAmount = NAIRA_REWARDS.OWN_GOAL_PENALTY;
                reason = `😬 Own goal! -₦${Math.abs(NAIRA_REWARDS.OWN_GOAL_PENALTY).toLocaleString()} penalty`;
                console.log(`😬 Own goal by ${scorer.username}`);
            } else {
                // PROPER GOAL — reward the scorer
                scorer.goals = (scorer.goals || 0) + 1;
                transactionAmount = NAIRA_REWARDS.GOAL;
                reason = `⚽ Goal scored! +₦${NAIRA_REWARDS.GOAL.toLocaleString()}`;
                console.log(`🥅 Goal by ${scorer.username}`);
            }

            // Process the Naira transaction
            const newBalance = await processNairaTransaction(
                scorer.userId,
                scorer.nairaBalance,
                transactionAmount
            );

            if (newBalance !== null) {
                scorer.nairaBalance = newBalance;

                // Tell the scorer their new balance
                io.to(scorerSocketId).emit('balance_updated', {
                    newBalance,
                    reason,
                    reward:    transactionAmount,
                    isOwnGoal: isOwnGoal || false
                });
            }
        }

        // Tell everyone the new score
        io.to(roomCode).emit('score_updated', {
            homeScore:   room.homeScore,
            awayScore:   room.awayScore,
            scorerName:  scorer ? scorer.username : 'Unknown',
            isHomeGoal,
            isOwnGoal:   isOwnGoal || false
        });
    });

    // --- MATCH END ---
    socket.on('match_ended', async (data) => {
        const { roomCode } = data;
        const room = activeRooms[roomCode];
        if (!room || room.matchEnded) return;

        room.matchEnded = true;

        const homeWon = room.homeScore > room.awayScore;
        const awayWon = room.awayScore > room.homeScore;
        const isDraw  = room.homeScore === room.awayScore;

        for (const player of room.players) {
            let result = 'loss';
            if (isDraw) result = 'draw';
            else if (player.isHome && homeWon)  result = 'win';
            else if (!player.isHome && awayWon) result = 'win';

            const reward = result === 'win'  ? NAIRA_REWARDS.WIN
                         : result === 'draw' ? NAIRA_REWARDS.DRAW
                         : NAIRA_REWARDS.LOSS;

            let reason = '';
            if (result === 'win')       reason = `🏆 Match won! +₦${NAIRA_REWARDS.WIN.toLocaleString()}`;
            else if (result === 'draw') reason = `🤝 Draw! +₦${NAIRA_REWARDS.DRAW.toLocaleString()}`;
            else                        reason = `😔 Match lost. No pay. Better luck next time!`;

            if (reward > 0) {
                const newBalance = await processNairaTransaction(
                    player.userId,
                    player.nairaBalance,
                    reward
                );

                if (newBalance !== null) {
                    player.nairaBalance = newBalance;
                    io.to(player.socketId).emit('balance_updated', {
                        newBalance, reason, reward
                    });
                }
            } else {
                // Loss — just send the message, no transaction
                io.to(player.socketId).emit('balance_updated', {
                    newBalance:  player.nairaBalance,
                    reason,
                    reward:      0
                });
            }
        }

        io.to(roomCode).emit('match_result', {
            homeScore: room.homeScore,
            awayScore: room.awayScore,
            homeWon,
            awayWon,
            isDraw
        });

        console.log(`🏁 Match ended: ${room.homeScore} - ${room.awayScore}`);
    });

    // --- PLAYER MOVEMENT ---
    socket.on('player_move', (data) => {
        for (const code in activeRooms) {
            const room = activeRooms[code];
            const player = room.players.find(p => p.socketId === socket.id);
            if (player) {
                player.x        = data.x;
                player.y        = data.y;
                player.username = data.username;
                player.isHome   = data.isHome;
                const positions = {};
                room.players.forEach(p => {
                    positions[p.socketId] = {
                        x:        p.x || 375,
                        y:        p.y || 210,
                        username: p.username,
                        isHome:   p.isHome
                    };
                });
                io.to(code).emit('player_positions', positions);
                break;
            }
        }
    });

    // --- E2EE CHAT ---
    socket.on('relay_encrypted_packet', (payload) => {
        const { targetSocketId, senderUsername, cipherText, payloadType } = payload;
        io.to(targetSocketId).emit('receive_encrypted_packet', {
            sender: senderUsername, cipherText, payloadType,
            timestamp: new Date().toLocaleTimeString()
        });
    });

    // --- WEBRTC ---
    socket.on('call_signal_exchange', (payload) => {
        const { targetSocketId, signalData, sender } = payload;
        io.to(targetSocketId).emit('incoming_call_signal', {
            sender, signalData, fromSocketId: socket.id
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
    console.log(`💰 Goal: +₦${NAIRA_REWARDS.GOAL} | Own Goal: -₦${Math.abs(NAIRA_REWARDS.OWN_GOAL_PENALTY)} | Win: +₦${NAIRA_REWARDS.WIN} | Draw: +₦${NAIRA_REWARDS.DRAW}`);
});