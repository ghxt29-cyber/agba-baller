// ============================================
// AGBA BALLER - Real Football Engine
// Possession-Based Ball System
// Dream League Soccer / PES Style Mechanics
// Ref: Master Document — 5v5 Street Football
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

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);
const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// GAME CONFIG
// ============================================
const NAIRA_REWARDS = {
    GOAL:             2500,
    OWN_GOAL_PENALTY: -750,
    WIN:              10000,
    DRAW:             1500,
    LOSS:             0
};

const STAMINA_CONFIG = {
    MAX:                  100,
    MIN:                  0,
    MATCH_BASE_DRAIN:     35,
    REST_RESTORE:         25,
    AGBO_RESTORE:         30,
    ENERGY_DRINK_RESTORE: 50,
    AGBO_COST:            600,
    ENERGY_DRINK_COST:    1300
};

const PITCH = {
    W:    750,
    H:    420,
    M:    20,
    GY1:  175,
    GY2:  245,
    GOAL_DEPTH: 30  // how deep into goal zone
};

// Ball constants
const BALL = {
    RADIUS:       9,
    FRICTION:     0.94,       // slows ball down
    STOP_SPEED:   0.3,        // below this speed ball is considered stopped
    CARRY_DIST:   16,         // distance ball stays from carrier feet
    PASS_POWER:   7,          // short pass power
    LONG_PASS:    11,         // long pass power
    SHOOT_POWER:  9,          // shot power
    TACKLE_RANGE: 20,         // how close defender must be to tackle
    CONTROL_RANGE:18          // how close player must be to take possession
};

// Formation — 5v5 all outfield (Master Document)
const HOME_FORM = [
    { role: 'ATT',   bx: 0.75, by: 0.50 },
    { role: 'MID-L', bx: 0.58, by: 0.28 },
    { role: 'MID-R', bx: 0.58, by: 0.72 },
    { role: 'DEF-L', bx: 0.32, by: 0.28 },
    { role: 'DEF-R', bx: 0.32, by: 0.72 }
];
const AWAY_FORM = [
    { role: 'ATT',   bx: 0.25, by: 0.50 },
    { role: 'MID-L', bx: 0.42, by: 0.28 },
    { role: 'MID-R', bx: 0.42, by: 0.72 },
    { role: 'DEF-L', bx: 0.68, by: 0.28 },
    { role: 'DEF-R', bx: 0.68, by: 0.72 }
];

const TICK_MS = 50;

// ============================================
// MATH HELPERS
// ============================================
function dist(ax, ay, bx, by) {
    const dx = ax - bx, dy = ay - by;
    return Math.sqrt(dx * dx + dy * dy);
}

function angle(fx, fy, tx, ty) {
    return Math.atan2(ty - fy, tx - fx);
}

function moveToward(entity, tx, ty, speed) {
    const dx = tx - entity.x, dy = ty - entity.y;
    const d  = Math.sqrt(dx * dx + dy * dy);
    if (d > 0.5) {
        entity.x += (dx / d) * Math.min(speed, d);
        entity.y += (dy / d) * Math.min(speed, d);
    }
}

function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
}

function randomBetween(a, b) {
    return a + Math.random() * (b - a);
}

// ============================================
// API ENDPOINTS
// ============================================
app.get('/api/config', (req, res) => {
    res.json({
        supabaseUrl:     process.env.SUPABASE_URL,
        supabaseAnonKey: process.env.SUPABASE_ANON_KEY
    });
});

app.post('/api/signup', async (req, res) => {
    const { email, password, username, homeState, homeLga, homeStreet } = req.body;
    if (!email || !password || !username || !homeState || !homeLga || !homeStreet)
        return res.json({ success: false, message: 'All fields are required.' });
    if (password.length < 6)
        return res.json({ success: false, message: 'Password must be at least 6 characters.' });
    if (username.length < 3)
        return res.json({ success: false, message: 'Baller name must be at least 3 characters.' });

    const clean = s => String(s).replace(/[<>'"]/g, '').trim();
    try {
        const { data: authData, error: authError } =
            await supabaseAdmin.auth.admin.createUser({
                email, password, email_confirm: true
            });
        if (authError) return res.json({ success: false, message: authError.message });

        const { error: profileError } = await supabaseAdmin.from('players').insert({
            user_id:       authData.user.id,
            username:      clean(username),
            home_state:    clean(homeState),
            home_lga:      clean(homeLga),
            home_street:   clean(homeStreet),
            naira_balance: 100000,
            stamina:       100
        });
        if (profileError)
            return res.json({ success: false, message: profileError.message });

        console.log(`✅ New baller: ${clean(username)} from ${clean(homeState)}`);
        return res.json({
            success: true,
            message: `Baller "${clean(username)}" created! Starting balance: ₦100,000`
        });
    } catch (err) {
        return res.json({ success: false, message: 'Server error.' });
    }
});

app.get('/api/player', async (req, res) => {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res.json({ success: false, message: 'No auth token.' });
    try {
        const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
        if (error || !user) return res.json({ success: false, message: 'Invalid session.' });
        const { data: player, error: pe } = await supabaseAdmin
            .from('players')
                 .select('username, home_state, home_lga, naira_balance, stamina, respect_points, attr_speed, attr_dribbling, attr_shooting, avatar_skin, avatar_hair, avatar_body, avatar_outfit, avatar_kit_color, avatar_kit_away, avatar_number, avatar_complete')
            .eq('user_id', user.id)
            .single();
        if (pe || !player) return res.json({ success: false, message: 'Player not found.' });
        return res.json({ success: true, player });
    } catch (err) {
        return res.json({ success: false, message: 'Server error.' });
    }
});

app.post('/api/stamina/recover', async (req, res) => {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res.json({ success: false, message: 'No auth token.' });
    const { method } = req.body;
    try {
        const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
        if (error || !user) return res.json({ success: false, message: 'Invalid session.' });
        const { data: player } = await supabaseAdmin
            .from('players').select('stamina, naira_balance')
            .eq('user_id', user.id).single();
        if (!player) return res.json({ success: false, message: 'Player not found.' });

        let restore = 0, cost = 0, name = '';
        if      (method === 'rest')         { restore = STAMINA_CONFIG.REST_RESTORE;         cost = 0;                                name = 'Rest'; }
        else if (method === 'agbo')         { restore = STAMINA_CONFIG.AGBO_RESTORE;         cost = STAMINA_CONFIG.AGBO_COST;         name = 'Agbo'; }
        else if (method === 'energy_drink') { restore = STAMINA_CONFIG.ENERGY_DRINK_RESTORE; cost = STAMINA_CONFIG.ENERGY_DRINK_COST; name = 'Energy Drink'; }
        else return res.json({ success: false, message: 'Invalid method.' });

        if (player.naira_balance < cost)
            return res.json({ success: false, message: `Need ₦${cost.toLocaleString()} for ${name}.` });
        if (player.stamina >= STAMINA_CONFIG.MAX)
            return res.json({ success: false, message: 'Stamina already full!' });

        const newStamina = Math.min(STAMINA_CONFIG.MAX, player.stamina + restore);
        const newBalance = player.naira_balance - cost;
        await supabaseAdmin.from('players')
            .update({ stamina: newStamina, naira_balance: newBalance })
            .eq('user_id', user.id);

        const costMsg = cost > 0 ? ` (-₦${cost.toLocaleString()})` : ' (Free)';
        return res.json({
            success: true, newStamina, newBalance,
            message: `${name} used! Stamina: ${player.stamina}% → ${newStamina}%${costMsg}`
        });
    } catch (err) {
        return res.json({ success: false, message: 'Server error.' });
    }
});

// ============================================
// NAIRA & STAMINA HELPERS
// ============================================
async function processNairaTransaction(userId, currentBalance, amount) {
    if (!userId) return null;
    const newBalance = Math.max(0, currentBalance + amount);
    const { error } = await supabaseAdmin
        .from('players').update({ naira_balance: newBalance }).eq('user_id', userId);
    if (error) { console.error('Naira error:', error.message); return null; }
    return newBalance;
}

async function drainStaminaDB(userId, currentStamina) {
    if (!userId) return null;
    const newStamina = Math.max(0, currentStamina - STAMINA_CONFIG.MATCH_BASE_DRAIN);
    const { error } = await supabaseAdmin
        .from('players').update({ stamina: newStamina }).eq('user_id', userId);
    if (error) { console.error('Stamina error:', error.message); return null; }
    return newStamina;
}

// ============================================
// BALL OBJECT FACTORY
// ============================================
function createBall() {
    return {
        x:          PITCH.W / 2,
        y:          PITCH.H / 2,
        vx:         0,
        vy:         0,
        carrierId:  null,   // socketId of player carrying it
        isLoose:    true    // true = no one has it
    };
}

// ============================================
// BALL PHYSICS TICK
// ============================================
function tickBall(ball, players) {
    if (!ball.isLoose) {
        // Ball is carried — move with carrier
        const carrier = players.find(p => p.socketId === ball.carrierId);
        if (!carrier) {
            // Carrier left — release ball
            ball.isLoose  = true;
            ball.carrierId = null;
        } else {
            // Stick ball to carrier's feet (slightly ahead in their direction)
            ball.x = carrier.x + Math.cos(carrier.facing || 0) * BALL.CARRY_DIST;
            ball.y = carrier.y + Math.sin(carrier.facing || 0) * BALL.CARRY_DIST;
            ball.vx = 0;
            ball.vy = 0;
        }
        return;
    }

    // Ball is loose — apply physics
    ball.x  += ball.vx;
    ball.y  += ball.vy;
    ball.vx *= BALL.FRICTION;
    ball.vy *= BALL.FRICTION;

    // Stop ball when nearly still
    if (Math.abs(ball.vx) < BALL.STOP_SPEED) ball.vx = 0;
    if (Math.abs(ball.vy) < BALL.STOP_SPEED) ball.vy = 0;

    // Wall bouncing
    if (ball.x - BALL.RADIUS < PITCH.M) {
        ball.x  = PITCH.M + BALL.RADIUS;
        ball.vx = Math.abs(ball.vx) * 0.6;
    }
    if (ball.x + BALL.RADIUS > PITCH.W - PITCH.M) {
        ball.x  = PITCH.W - PITCH.M - BALL.RADIUS;
        ball.vx = -Math.abs(ball.vx) * 0.6;
    }
    if (ball.y - BALL.RADIUS < PITCH.M) {
        ball.y  = PITCH.M + BALL.RADIUS;
        ball.vy = Math.abs(ball.vy) * 0.6;
    }
    if (ball.y + BALL.RADIUS > PITCH.H - PITCH.M) {
        ball.y  = PITCH.H - PITCH.M - BALL.RADIUS;
        ball.vy = -Math.abs(ball.vy) * 0.6;
    }

    // Check if any player picks up the loose ball
    for (const p of players) {
        const d = dist(p.x, p.y, ball.x, ball.y);
        if (d <= BALL.CONTROL_RANGE) {
            ball.isLoose   = false;
            ball.carrierId = p.socketId;
            ball.vx        = 0;
            ball.vy        = 0;
            break;
        }
    }
}

// ============================================
// PASS THE BALL
// ============================================
function passBall(ball, fromPlayer, toPlayer, isLong) {
    const power = isLong ? BALL.LONG_PASS : BALL.PASS_POWER;
    const a     = angle(fromPlayer.x, fromPlayer.y, toPlayer.x, toPlayer.y);

    // Lead the pass slightly ahead of the receiver
    const lead = isLong ? 40 : 20;
    const targetX = toPlayer.x + Math.cos(a) * lead;
    const targetY = toPlayer.y + Math.sin(a) * lead;
    const a2    = angle(fromPlayer.x, fromPlayer.y, targetX, targetY);

    ball.isLoose   = true;
    ball.carrierId = null;
    ball.vx        = Math.cos(a2) * power;
    ball.vy        = Math.sin(a2) * power;
}

// ============================================
// SHOOT AT GOAL
// ============================================
function shootAtGoal(ball, fromPlayer, isHome) {
    // Target the monkey post goal
    const goalX   = isHome ? PITCH.W - PITCH.M : PITCH.M;
    const goalY   = PITCH.H / 2 + randomBetween(-25, 25); // aim within goal
    const a       = angle(fromPlayer.x, fromPlayer.y, goalX, goalY);
    const scatter = randomBetween(-0.12, 0.12); // slight inaccuracy = street football

    ball.isLoose   = true;
    ball.carrierId = null;
    ball.vx        = Math.cos(a + scatter) * BALL.SHOOT_POWER;
    ball.vy        = Math.sin(a + scatter) * BALL.SHOOT_POWER;

    console.log(`🥅 Shot by ${fromPlayer.username} (${isHome ? 'Home' : 'Away'})`);
}

// ============================================
// TACKLE
// ============================================
function attemptTackle(defender, ball, players) {
    if (ball.isLoose) return false;
    const carrier = players.find(p => p.socketId === ball.carrierId);
    if (!carrier) return false;
    if (carrier.isHome === defender.isHome) return false; // no friendly tackles

    const d = dist(defender.x, defender.y, carrier.x, carrier.y);
    if (d > BALL.TACKLE_RANGE) return false;

    // Tackle success chance — higher for defenders, lower for attackers
    const successChance = defender.role === 'DEF-L' || defender.role === 'DEF-R' ? 0.65 : 0.45;

    if (Math.random() < successChance) {
        // Successful tackle — ball becomes loose and bounces away
        ball.isLoose   = true;
        ball.carrierId = null;
        const a        = angle(carrier.x, carrier.y, defender.x, defender.y);
        ball.vx        = Math.cos(a) * 3;
        ball.vy        = Math.sin(a) * 3;
        console.log(`⚔️ ${defender.username} tackled ${carrier.username}!`);
        return true;
    }
    return false;
}

// ============================================
// GOAL CHECK
// ============================================
function checkGoal(ball) {
    if (ball.x - BALL.RADIUS <= PITCH.M &&
        ball.y > PITCH.GY1 && ball.y < PITCH.GY2) return 'left';
    if (ball.x + BALL.RADIUS >= PITCH.W - PITCH.M &&
        ball.y > PITCH.GY1 && ball.y < PITCH.GY2) return 'right';
    return null;
}

function resetBallCentre(ball) {
    ball.x         = PITCH.W / 2;
    ball.y         = PITCH.H / 2;
    ball.vx        = 0;
    ball.vy        = 0;
    ball.isLoose   = true;
    ball.carrierId = null;
}

// ============================================
// FIND BEST TEAMMATE TO PASS TO
// ============================================
function findPassTarget(carrier, teammates, isHome) {
    // Find the most advanced open teammate
    let best     = null;
    let bestScore = -Infinity;

    for (const t of teammates) {
        if (t.socketId === carrier.socketId) continue;

        // Score = how far forward they are (toward opponent goal)
        const forwardness = isHome ? t.x : PITCH.W - t.x;

        // Penalise if they are very close (no point in short square pass)
        const d = dist(carrier.x, carrier.y, t.x, t.y);
        if (d < 30) continue;

        // Penalise if an opponent is between carrier and teammate
        const score = forwardness - d * 0.2;
        if (score > bestScore) {
            bestScore = score;
            best      = t;
        }
    }

    return best;
}

// ============================================
// AI DECISION ENGINE — per player per tick
// This is the heart of the football intelligence
// ============================================
function tickPlayerAI(player, ball, room) {
    if (!player.isAI) return;

    const players      = room.players;
    const isHome       = player.isHome;
    const form         = isHome ? HOME_FORM : AWAY_FORM;
    const slot         = form.find(f => f.role === player.role) || form[0];
    const teammates    = players.filter(p => p.isHome === isHome && p.socketId !== player.socketId);
    const opponents    = players.filter(p => p.isHome !== isHome);
    const speed        = getAISpeed(player.role);

    // Dynamic base position — shift with ball
    const ballInflX    = isHome
        ? slot.bx + (ball.x / PITCH.W - 0.5) * 0.12
        : slot.bx - (ball.x / PITCH.W - 0.5) * 0.12;
    const ballInflY    = slot.by + (ball.y / PITCH.H - 0.5) * 0.18;
    const homeX        = clamp(ballInflX, 0.05, 0.95) * PITCH.W;
    const homeY        = clamp(ballInflY, 0.05, 0.95) * PITCH.H;

    // ── CASE 1: I HAVE THE BALL ──
    if (ball.carrierId === player.socketId) {

        player.aiDecisionTimer = (player.aiDecisionTimer || 0) + 1;

        // Update facing direction toward goal
        const goalX        = isHome ? PITCH.W : 0;
        player.facing      = angle(player.x, player.y, goalX, PITCH.H / 2);

        const distToGoal   = dist(player.x, player.y, isHome ? PITCH.W - PITCH.M : PITCH.M, PITCH.H / 2);
        const inShootRange = isHome ? player.x > PITCH.W * 0.65 : player.x < PITCH.W * 0.35;

        // Wait a short moment before deciding (simulates thinking)
        if (player.aiDecisionTimer < 8) {
            // Dribble toward goal while deciding
            const dribbleX = isHome ? player.x + 3 : player.x - 3;
            moveToward(player, dribbleX, player.y + randomBetween(-1, 1), speed);
            return;
        }

        player.aiDecisionTimer = 0;

        if (inShootRange && Math.random() < 0.55) {
            // SHOOT — in range and chose to shoot
            shootAtGoal(ball, player, isHome);

        } else {
            // PASS — find best teammate
            const target = findPassTarget(player, teammates, isHome);

            if (target) {
                const isLong = dist(player.x, player.y, target.x, target.y) > 180;
                passBall(ball, player, target, isLong);
            } else {
                // No good pass — dribble forward
                const dribbleX = isHome
                    ? clamp(player.x + 4, PITCH.M, PITCH.W - PITCH.M)
                    : clamp(player.x - 4, PITCH.M, PITCH.W - PITCH.M);
                const dribbleY = player.y + randomBetween(-2, 2);
                moveToward(player, dribbleX, dribbleY, speed);
            }
        }

        return;
    }

    // ── CASE 2: TEAMMATE HAS THE BALL ──
    const ballCarrier = players.find(p => p.socketId === ball.carrierId);
    const myTeamHasBall = ballCarrier && ballCarrier.isHome === isHome;

    if (myTeamHasBall) {
        // Make a run — move into space ahead of play
        if (player.role === 'ATT') {
            // Attacker — make a forward run toward goal
            const runX = isHome
                ? clamp(ball.x + 100, PITCH.W * 0.5, PITCH.W - 40)
                : clamp(ball.x - 100, 40, PITCH.W * 0.5);
            const runY = clamp(homeY + randomBetween(-30, 30), PITCH.M, PITCH.H - PITCH.M);
            moveToward(player, runX, runY, speed * 0.9);

        } else if (player.role.startsWith('MID')) {
            // Midfielder — support play, spread wide
            const supportX = isHome
                ? clamp(ball.x + 50, PITCH.W * 0.3, PITCH.W - 60)
                : clamp(ball.x - 50, 60, PITCH.W * 0.7);
            moveToward(player, supportX, homeY, speed * 0.75);

        } else {
            // Defender — hold shape, don't push too far
            moveToward(player, homeX, homeY, speed * 0.5);
        }
        return;
    }

    // ── CASE 3: OPPONENT HAS THE BALL ──
    if (ballCarrier && ballCarrier.isHome !== isHome) {

        if (player.role === 'DEF-L' || player.role === 'DEF-R') {
            // Defender — pressure the ball carrier
            const pressX = clamp(ballCarrier.x + (isHome ? 15 : -15), PITCH.M, PITCH.W - PITCH.M);
            moveToward(player, pressX, ballCarrier.y, speed);

            // Attempt tackle if in range
            attemptTackle(player, ball, players);

        } else if (player.role.startsWith('MID')) {
            // Midfielder — track back and cut passing lanes
            const trackX = isHome
                ? clamp(ballCarrier.x - 60, PITCH.M, PITCH.W * 0.6)
                : clamp(ballCarrier.x + 60, PITCH.W * 0.4, PITCH.W - PITCH.M);
            moveToward(player, trackX, clamp(ballCarrier.y, PITCH.M, PITCH.H - PITCH.M), speed * 0.85);

        } else if (player.role === 'ATT') {
            // Attacker — press high, harry the defender
            moveToward(player, ballCarrier.x, ballCarrier.y, speed * 0.7);
        }
        return;
    }

    // ── CASE 4: BALL IS LOOSE ──
    if (ball.isLoose) {
        const dToBall = dist(player.x, player.y, ball.x, ball.y);

        // Only the nearest player on each team should aggressively chase
        const myTeam       = players.filter(p => p.isHome === isHome && p.isAI);
        const nearestOnTeam = myTeam.reduce((n, p) =>
            dist(p.x, p.y, ball.x, ball.y) < dist(n.x, n.y, ball.x, ball.y) ? p : n
        , myTeam[0]);

        if (nearestOnTeam && player.socketId === nearestOnTeam.socketId) {
            // I am the nearest — sprint to ball
            moveToward(player, ball.x, ball.y, speed * 1.1);
        } else {
            // Others — move to supporting position
            const supportX = isHome
                ? clamp(ball.x - 50, PITCH.M, PITCH.W * 0.6)
                : clamp(ball.x + 50, PITCH.W * 0.4, PITCH.W - PITCH.M);
            moveToward(player, supportX, homeY, speed * 0.7);
        }
        return;
    }

    // ── DEFAULT: hold formation ──
    moveToward(player, homeX, homeY, speed * 0.4);
}

function getAISpeed(role) {
    const speeds = {
        'ATT':   2.4,
        'MID-L': 2.1,
        'MID-R': 2.1,
        'DEF-L': 1.9,
        'DEF-R': 1.9
    };
    return speeds[role] || 2.0;
}

// ============================================
// SEPARATION — stop players stacking
// ============================================
function separatePlayers(players) {
    for (let i = 0; i < players.length; i++) {
        for (let j = i + 1; j < players.length; j++) {
            const a = players[i], b = players[j];
            const d = dist(a.x, a.y, b.x, b.y);
            if (d < 24 && d > 0) {
                const push = (24 - d) / 2;
                const dx   = (a.x - b.x) / d * push;
                const dy   = (a.y - b.y) / d * push;
                a.x += dx; a.y += dy;
                b.x -= dx; b.y -= dy;
            }
        }
    }

    // Keep in bounds
    for (const p of players) {
        p.x = clamp(p.x, 28, PITCH.W - 28);
        p.y = clamp(p.y, 28, PITCH.H - 28);
    }
}

// ============================================
// ROOM STORE & GAME LOOPS
// ============================================
const activeRooms = {};
const gameLoops   = {};

function startGameLoop(code) {
    const room = activeRooms[code];
    if (!room || gameLoops[code]) return;

    room.matchSeconds      = 0;
    room.lastToucherId     = null;
    room.lastToucherIsHome = null;

    gameLoops[code] = setInterval(async () => {
        const room = activeRooms[code];
        if (!room) {
            clearInterval(gameLoops[code]);
            delete gameLoops[code];
            return;
        }

        const ball    = room.ball;
        const players = room.players;

        // Track last toucher for goal attribution
        if (!ball.isLoose && ball.carrierId) {
            const carrier = players.find(p => p.socketId === ball.carrierId);
            if (carrier) {
                room.lastToucherId     = carrier.socketId;
                room.lastToucherIsHome = carrier.isHome;
            }
        }

        // Tick all AI players
        for (const p of players) {
            if (p.isAI) tickPlayerAI(p, ball, room);
        }

        // Separate overlapping players
        separatePlayers(players);

        // Tick ball
        tickBall(ball, players);

        // Match timer
        room.matchSeconds++;

        // Goal check
        const goal = checkGoal(ball);
        if (goal) {
            const isHomeGoal = goal === 'right';
            const isOwnGoal  = isHomeGoal
                ? room.lastToucherIsHome === false
                : room.lastToucherIsHome === true;

            if (isHomeGoal) room.homeScore++;
            else            room.awayScore++;

            const scorer = players.find(p => p.socketId === room.lastToucherId);
            if (scorer && !scorer.isAI) {
                const amount = isOwnGoal
                    ? NAIRA_REWARDS.OWN_GOAL_PENALTY
                    : NAIRA_REWARDS.GOAL;
                const reason = isOwnGoal
                    ? `😬 Own goal! -₦${Math.abs(NAIRA_REWARDS.OWN_GOAL_PENALTY).toLocaleString()} penalty`
                    : `⚽ Goal! +₦${NAIRA_REWARDS.GOAL.toLocaleString()}`;
                const newBal = await processNairaTransaction(
                    scorer.userId, scorer.nairaBalance, amount
                );
                if (newBal !== null) {
                    scorer.nairaBalance = newBal;
                    io.to(scorer.socketId).emit('balance_updated', {
                        newBalance: newBal, reason, reward: amount, isOwnGoal
                    });
                }
            }

            io.to(code).emit('score_updated', {
                homeScore:  room.homeScore,
                awayScore:  room.awayScore,
                scorerName: scorer ? scorer.username : 'Unknown',
                isOwnGoal
            });

            resetBallCentre(ball);

            // Reset all players to formation after goal
            resetPlayersToFormation(room);
        }

        // Build positions payload
        const positions = {};
        for (const p of players) {
            positions[p.socketId] = {
                x:        p.x,
                y:        p.y,
                username: p.username,
                isHome:   p.isHome,
                stamina:  p.stamina || 100,
                isAI:     p.isAI || false,
                role:     p.role || 'MID-L',
                hasBall:  ball.carrierId === p.socketId
            };
        }

        io.to(code).emit('game_tick', {
            ball: {
                x:       ball.x,
                y:       ball.y,
                isLoose: ball.isLoose,
                carrier: ball.carrierId
            },
            players:      positions,
            homeScore:    room.homeScore,
            awayScore:    room.awayScore,
            matchSeconds: room.matchSeconds
        });

    }, TICK_MS);

    console.log(`🎮 Game loop started: ${code}`);
}

function resetPlayersToFormation(room) {
    const homePlayers = room.players.filter(p => p.isHome);
    const awayPlayers = room.players.filter(p => !p.isHome);

    homePlayers.forEach((p, i) => {
        const slot = HOME_FORM[i % HOME_FORM.length];
        p.x = slot.bx * PITCH.W + randomBetween(-15, 15);
        p.y = slot.by * PITCH.H + randomBetween(-15, 15);
    });

    awayPlayers.forEach((p, i) => {
        const slot = AWAY_FORM[i % AWAY_FORM.length];
        p.x = slot.bx * PITCH.W + randomBetween(-15, 15);
        p.y = slot.by * PITCH.H + randomBetween(-15, 15);
    });
}

function stopGameLoop(code) {
    if (gameLoops[code]) {
        clearInterval(gameLoops[code]);
        delete gameLoops[code];
        console.log(`🛑 Game loop stopped: ${code}`);
    }
}

// ============================================
// SOCKET.IO
// ============================================
io.on('connection', (socket) => {
    console.log(`✅ Connected: ${socket.id}`);

    socket.on('create_street_team', async (data) => {
        const clean    = s => String(s).replace(/[<>'"]/g, '').trim();
        const teamName = clean(data.teamName);
        const username = clean(data.username);

        if (!teamName || !username) {
            socket.emit('error_message', { msg: 'Team name and username required.' });
            return;
        }

        const code = Math.random().toString(36).substring(2, 8).toUpperCase();

        const captain = {
            socketId:          socket.id,
            username,
            role:              'ATT',
            userId:            data.userId || null,
            nairaBalance:      data.nairaBalance || 100000,
            stamina:           data.stamina || 100,
            isHome:            true,
            isAI:              false,
            x:                 HOME_FORM[0].bx * PITCH.W,
            y:                 HOME_FORM[0].by * PITCH.H,
            facing:            0,
            aiDecisionTimer:   0,
            goals:             0,
            ownGoals:          0
        };

        activeRooms[code] = {
            teamName,
            players:      [captain],
            maxPlayers:   5,
            homeScore:    0,
            awayScore:    0,
            matchStarted: false,
            matchEnded:   false,
            ball:         createBall()
        };

        socket.join(code);
        socket.currentRoom = code;

        const { error } = await supabase.from('teams').insert({
            team_name: teamName, invite_code: code, escrow_stake_balance: 0
        });
        if (error) console.error('Team save error:', error.message);

        socket.emit('team_created', {
            inviteCode: code, teamName,
            players:    activeRooms[code].players
        });

        console.log(`🏟️ Team: ${teamName} | Code: ${code}`);
    });

    socket.on('join_street_team', (data) => {
        const code     = String(data.inviteCode).replace(/[^A-Z0-9]/g, '').toUpperCase();
        const username = String(data.username).replace(/[<>'"]/g, '').trim();
        const room     = activeRooms[code];

        if (!room) {
            socket.emit('error_message', { msg: 'Invite code not found.' }); return;
        }
        if (room.matchStarted) {
            socket.emit('error_message', { msg: 'Match already in progress!' }); return;
        }

        const awayCount = room.players.filter(p => !p.isHome && !p.isAI).length;
        const formSlot  = AWAY_FORM[awayCount % AWAY_FORM.length];

        const newPlayer = {
            socketId:        socket.id,
            username,
            role:            formSlot.role,
            userId:          data.userId || null,
            nairaBalance:    data.nairaBalance || 100000,
            stamina:         data.stamina || 100,
            isHome:          false,
            isAI:            false,
            x:               formSlot.bx * PITCH.W,
            y:               formSlot.by * PITCH.H,
            facing:          Math.PI,
            aiDecisionTimer: 0,
            goals:           0,
            ownGoals:        0
        };

        room.players.push(newPlayer);
        socket.join(code);
        socket.currentRoom = code;

        io.to(code).emit('player_joined', {
            username, players: room.players, teamName: room.teamName
        });

        console.log(`⚽ ${username} joined: ${room.teamName} as ${formSlot.role}`);
    });

    socket.on('kick_off', (data) => {
        const { roomCode } = data;
        const room = activeRooms[roomCode];
        if (!room || room.matchStarted) return;

        const captain = room.players.find(
            p => p.socketId === socket.id && p.role === 'ATT'
        );
        if (!captain) {
            socket.emit('error_message', { msg: 'Only the Captain can start the match!' });
            return;
        }

        room.matchStarted = true;

        const streetNames = ['Emeka','Tunde','Chidi','Biodun','Remi','Kayode','Festus','Uche','Bello','Dayo'];
        let nameIdx = 0;

        // Fill home team to 5
        const homeHumans  = room.players.filter(p => p.isHome && !p.isAI);
        for (let i = homeHumans.length; i < 5; i++) {
            const slot = HOME_FORM[i];
            room.players.push({
                socketId:        `AI_h${i}_${roomCode}`,
                username:        streetNames[nameIdx++ % streetNames.length] + '_CPU',
                role:            slot.role,
                userId:          null,
                nairaBalance:    0,
                stamina:         100,
                isHome:          true,
                isAI:            true,
                x:               slot.bx * PITCH.W + randomBetween(-10, 10),
                y:               slot.by * PITCH.H + randomBetween(-10, 10),
                facing:          0,
                aiDecisionTimer: Math.floor(Math.random() * 10),
                goals:           0,
                ownGoals:        0
            });
        }

        // Fill away team to 5
        const awayHumans = room.players.filter(p => !p.isHome && !p.isAI);
        for (let i = awayHumans.length; i < 5; i++) {
            const slot = AWAY_FORM[i];
            room.players.push({
                socketId:        `AI_a${i}_${roomCode}`,
                username:        streetNames[nameIdx++ % streetNames.length] + '_CPU',
                role:            slot.role,
                userId:          null,
                nairaBalance:    0,
                stamina:         100,
                isHome:          false,
                isAI:            true,
                x:               slot.bx * PITCH.W + randomBetween(-10, 10),
                y:               slot.by * PITCH.H + randomBetween(-10, 10),
                facing:          Math.PI,
                aiDecisionTimer: Math.floor(Math.random() * 10),
                goals:           0,
                ownGoals:        0
            });
        }

        // Give ball to captain to start
        room.ball.isLoose   = false;
        room.ball.carrierId = captain.socketId;
        room.ball.x         = captain.x;
        room.ball.y         = captain.y;

        io.to(roomCode).emit('match_kicked_off', {
            message: '⚽ WHISTLE BLOWN! Match has started!',
            players: room.players
        });

        startGameLoop(roomCode);
        console.log(`🏁 Kick off: ${room.teamName}`);
    });

    // Human player movement
    socket.on('player_move', (data) => {
        const room = activeRooms[socket.currentRoom];
        if (!room || !room.matchStarted) return;

        const player = room.players.find(p => p.socketId === socket.id && !p.isAI);
        if (!player) return;

        const prevX    = player.x;
        const prevY    = player.y;
        player.x       = clamp(data.x, 28, PITCH.W - 28);
        player.y       = clamp(data.y, 28, PITCH.H - 28);

        // Update facing direction from movement
        const dx = player.x - prevX;
        const dy = player.y - prevY;
        if (Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1) {
            player.facing = Math.atan2(dy, dx);
        }

        // If I have the ball, ball follows me
        if (room.ball.carrierId === socket.id) {
            room.ball.x = player.x + Math.cos(player.facing) * BALL.CARRY_DIST;
            room.ball.y = player.y + Math.sin(player.facing) * BALL.CARRY_DIST;
        }

        // If ball is loose and I'm close, I pick it up
        if (room.ball.isLoose) {
            const d = dist(player.x, player.y, room.ball.x, room.ball.y);
            if (d <= BALL.CONTROL_RANGE) {
                room.ball.isLoose   = false;
                room.ball.carrierId = socket.id;
                room.lastToucherId  = socket.id;
                room.lastToucherIsHome = player.isHome;
            }
        }
    });

    // Human player shoots
    socket.on('player_shoot', (data) => {
        const room = activeRooms[socket.currentRoom];
        if (!room || !room.matchStarted) return;
        if (room.ball.carrierId !== socket.id) return;

        const player = room.players.find(p => p.socketId === socket.id);
        if (!player) return;

        shootAtGoal(room.ball, player, player.isHome);
        room.lastToucherId     = socket.id;
        room.lastToucherIsHome = player.isHome;
    });

    // Human player passes
    socket.on('player_pass', (data) => {
        const room = activeRooms[socket.currentRoom];
        if (!room || !room.matchStarted) return;
        if (room.ball.carrierId !== socket.id) return;

        const player    = room.players.find(p => p.socketId === socket.id);
        if (!player) return;

        const teammates = room.players.filter(
            p => p.isHome === player.isHome && p.socketId !== socket.id
        );
        const target    = findPassTarget(player, teammates, player.isHome);
        if (target) {
            const isLong = dist(player.x, player.y, target.x, target.y) > 180;
            passBall(room.ball, player, target, isLong);
            room.lastToucherId     = socket.id;
            room.lastToucherIsHome = player.isHome;
        }
    });

    socket.on('match_ended', async (data) => {
        const { roomCode } = data;
        const room = activeRooms[roomCode];
        if (!room || room.matchEnded) return;

        room.matchEnded = true;
        stopGameLoop(roomCode);

        const homeWon = room.homeScore > room.awayScore;
        const awayWon = room.awayScore > room.homeScore;
        const isDraw  = room.homeScore === room.awayScore;

        for (const player of room.players) {
            if (player.isAI) continue;

            let result = 'loss';
            if (isDraw)                         result = 'draw';
            else if (player.isHome && homeWon)  result = 'win';
            else if (!player.isHome && awayWon) result = 'win';

            const reward = result === 'win'  ? NAIRA_REWARDS.WIN
                         : result === 'draw' ? NAIRA_REWARDS.DRAW : 0;
            const reason = result === 'win'
                ? `🏆 Match won! +₦${NAIRA_REWARDS.WIN.toLocaleString()}`
                : result === 'draw'
                ? `🤝 Draw! +₦${NAIRA_REWARDS.DRAW.toLocaleString()}`
                : `😔 Match lost. No pay. Rest up!`;

            if (reward > 0) {
                const newBal = await processNairaTransaction(
                    player.userId, player.nairaBalance, reward
                );
                if (newBal !== null) {
                    player.nairaBalance = newBal;
                    io.to(player.socketId).emit('balance_updated', {
                        newBalance: newBal, reason, reward
                    });
                }
            } else {
                io.to(player.socketId).emit('balance_updated', {
                    newBalance: player.nairaBalance, reason, reward: 0
                });
            }

            const newStam = await drainStaminaDB(player.userId, player.stamina);
            if (newStam !== null) {
                io.to(player.socketId).emit('stamina_drained', {
                    newStamina:  newStam,
                    drainAmount: STAMINA_CONFIG.MATCH_BASE_DRAIN,
                    message:     `⚡ Match over! Stamina -${STAMINA_CONFIG.MATCH_BASE_DRAIN}%. Now at ${newStam}%`
                });
            }
        }

        io.to(roomCode).emit('match_result', {
            homeScore: room.homeScore, awayScore: room.awayScore,
            homeWon, awayWon, isDraw
        });

        console.log(`🏁 Match ended: ${room.homeScore} - ${room.awayScore}`);
    });

    socket.on('relay_encrypted_packet', (payload) => {
        const { targetSocketId, senderUsername, cipherText, payloadType } = payload;
        io.to(targetSocketId).emit('receive_encrypted_packet', {
            sender: senderUsername, cipherText, payloadType,
            timestamp: new Date().toLocaleTimeString()
        });
    });

    socket.on('call_signal_exchange', (payload) => {
        const { targetSocketId, signalData, sender } = payload;
        io.to(targetSocketId).emit('incoming_call_signal', {
            sender, signalData, fromSocketId: socket.id
        });
    });

    socket.on('disconnect', () => {
        console.log(`❌ Disconnected: ${socket.id}`);
        for (const code in activeRooms) {
            const room = activeRooms[code];
            room.players = room.players.filter(p => p.socketId !== socket.id);
            if (room.players.filter(p => !p.isAI).length === 0) {
                stopGameLoop(code);
                delete activeRooms[code];
            }
        }
    });
});
// ============================================
// AVATAR API
// ============================================
app.post('/api/avatar/save', async (req, res) => {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res.json({ success: false, message: 'Not authorised.' });

    try {
        const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
        if (error || !user) return res.json({ success: false, message: 'Invalid session.' });

        const {
            avatar_skin, avatar_hair, avatar_body,
            avatar_outfit, avatar_kit_color, avatar_kit_away,
            avatar_number, avatar_complete
        } = req.body;

        const { error: updateError } = await supabaseAdmin
            .from('players')
            .update({
                avatar_skin:      String(avatar_skin      || 'medium').substring(0, 20),
                avatar_hair:      String(avatar_hair      || 'lowcut').substring(0, 30),
                avatar_body:      String(avatar_body      || 'athletic').substring(0, 20),
                avatar_outfit:    String(avatar_outfit    || 'casuals').substring(0, 30),
                avatar_kit_color: String(avatar_kit_color || '#00cc44').substring(0, 10),
                avatar_kit_away:  String(avatar_kit_away  || '#ffcc00').substring(0, 10),
                avatar_number:    Math.min(99, Math.max(1, parseInt(avatar_number) || 10)),
                avatar_complete:  true
            })
            .eq('user_id', user.id);

        if (updateError) {
            console.error('Avatar save error:', updateError.message);
            return res.json({ success: false, message: updateError.message });
        }

        console.log(`👤 Avatar saved for user ${user.id}`);
        return res.json({ success: true, message: 'Avatar saved!' });

    } catch (err) {
        console.error('Avatar error:', err);
        return res.json({ success: false, message: 'Server error.' });
    }
});
// ============================================
// MARKETPLACE API
// ============================================

// Market config
const MARKET_CONFIG = {
    BASIC_STALL_RENT:   15000,
    PREMIUM_STALL_RENT: 25000,
    HAGGLE_MIN_PCT:     0.70,  // vendor won't go below 70% of asking price
    HAGGLE_MAX_ROUNDS:  3      // max haggle rounds per transaction
};

// Government stalls — always stocked, fixed base prices
const GOV_STALLS = [
    {
        id:          'gov_001',
        stallNumber: 'A1',
        type:        'government',
        vendorName:  'Mama Chidinma',
        stallName:   "Mama Chidinma's Agbo Spot",
        category:    'Health & Stamina',
        personality: 'warm',
        greeting:    'My pikin! You don come. Wetin you need today?',
        items: [
            { id: 'agbo',         name: 'Agbo (Herbal Remedy)', price: 600,  stock: 999, effect: 'stamina+30',  description: 'Local herbs. Restore 30% stamina.' },
            { id: 'agbo_strong',  name: 'Strong Agbo',          price: 1100, stock: 999, effect: 'stamina+55',  description: 'Extra strong batch. Restore 55% stamina.' },
            { id: 'cold_water',   name: 'Pure Water (Sachet)',   price: 100,  stock: 999, effect: 'stamina+5',   description: 'Quick hydration. +5% stamina.' }
        ]
    },
    {
        id:          'gov_002',
        stallNumber: 'A2',
        type:        'government',
        vendorName:  'Chukwudi',
        stallName:   "Chukwudi's Energy Kiosk",
        category:    'Energy Drinks',
        personality: 'hype',
        greeting:    'Guy! You don come to the right place. I get the best energy drink for Lagos!',
        items: [
            { id: 'energy_drink',  name: 'Energy Drink (Power Horse)', price: 1300, stock: 999, effect: 'stamina+50', description: 'Imported energy. Restore 50% stamina.' },
            { id: 'malt_drink',    name: 'Maltina',                    price: 400,  stock: 999, effect: 'stamina+15', description: 'Sweet malt. +15% stamina.' },
            { id: 'lucozade',      name: 'Lucozade Sport',             price: 800,  stock: 999, effect: 'stamina+25', description: 'Sport drink. +25% stamina.' }
        ]
    },
    {
        id:          'gov_003',
        stallNumber: 'B1',
        type:        'government',
        vendorName:  'Mama Tunde',
        stallName:   "Mama Tunde's Buka",
        category:    'Food',
        personality: 'motherly',
        greeting:    'Oya come and chop! Food don ready. You go play better when your belle full.',
        items: [
            { id: 'jollof_rice',   name: 'Jollof Rice + Chicken',  price: 1800, stock: 50, effect: 'stamina+40,health', description: 'Full meal. +40% stamina and health boost.' },
            { id: 'eba_egusi',     name: 'Eba + Egusi Soup',       price: 1500, stock: 50, effect: 'stamina+35',        description: 'Heavy local meal. +35% stamina.' },
            { id: 'suya',          name: 'Suya (5 sticks)',         price: 1000, stock: 80, effect: 'stamina+20',        description: 'Spiced grilled meat. +20% stamina.' },
            { id: 'pure_water_x3', name: 'Pure Water x3',           price: 250,  stock: 999, effect: 'stamina+10',       description: 'Stay hydrated. +10% stamina.' }
        ]
    },
    {
        id:          'gov_004',
        stallNumber: 'B2',
        type:        'government',
        vendorName:  'Emeka Shoe',
        stallName:   "Emeka's Aba Footwear",
        category:    'Football Boots',
        personality: 'salesman',
        greeting:    'Oga! See fine boots! Aba made, quality guaranteed. Your speed go increase!',
        items: [
            { id: 'canvas_boots',  name: 'Canvas Boots (Aba Made)',   price: 8000,  stock: 20, effect: 'speed+5',  description: '+5 Speed attribute. Durable street boots.' },
            { id: 'leather_boots', name: 'Leather Football Boots',    price: 18000, stock: 10, effect: 'speed+12', description: '+12 Speed attribute. Premium quality.' },
            { id: 'slides',        name: 'Slides (Street Special)',    price: 3000,  stock: 30, effect: 'speed+2',  description: '+2 Speed. The street classic.' }
        ]
    },
    {
        id:          'gov_005',
        stallNumber: 'C1',
        type:        'government',
        vendorName:  'Tailor Biodun',
        stallName:   "Biodun's Jersey Stall",
        category:    'Jerseys & Kits',
        personality: 'creative',
        greeting:    'Ah-ah! You still dey wear that bib? Come make I dress you proper for the street!',
        items: [
            { id: 'basic_jersey',    name: 'Basic Custom Jersey',      price: 5000,  stock: 30, effect: 'kit:CustomJersey', description: 'Upgrade from bib to custom jersey.' },
            { id: 'premium_jersey',  name: 'Premium Jersey + Name',    price: 12000, stock: 15, effect: 'kit:CustomJersey+name', description: 'Premium jersey with your name on back.' },
            { id: 'full_kit',        name: 'Full Kit (Jersey+Shorts)',  price: 20000, stock: 10, effect: 'kit:FullKit', description: 'Complete matching kit. Full respect.' }
        ]
    },
    {
        id:          'gov_006',
        stallNumber: 'C2',
        type:        'government',
        vendorName:  'Pharmacist Ngozi',
        stallName:   "Ngozi's Street Chemist",
        category:    'Medical',
        personality: 'professional',
        greeting:    'Good day. How can I help you? We have medication for all football injuries.',
        items: [
            { id: 'pain_relief',   name: 'Pain Relief Tablet',    price: 500,  stock: 100, effect: 'health:Healthy',   description: 'Clears minor injuries. Back to Healthy.' },
            { id: 'muscle_rub',    name: 'Deep Heat Muscle Rub',  price: 1200, stock: 50,  effect: 'stamina+10,health', description: 'Eases muscle pain. +10% stamina.' },
            { id: 'glucose',       name: 'Glucose Drink',         price: 800,  stock: 80,  effect: 'stamina+20',        description: 'Quick energy boost. +20% stamina.' }
        ]
    }
];

// In-memory player stalls (rented by real players)
const playerStalls = {};

// Available rental spots
const RENTAL_SPOTS = [
    { id: 'rent_D1', stallNumber: 'D1', type: 'basic',   monthlyRent: MARKET_CONFIG.BASIC_STALL_RENT },
    { id: 'rent_D2', stallNumber: 'D2', type: 'basic',   monthlyRent: MARKET_CONFIG.BASIC_STALL_RENT },
    { id: 'rent_D3', stallNumber: 'D3', type: 'basic',   monthlyRent: MARKET_CONFIG.BASIC_STALL_RENT },
    { id: 'rent_E1', stallNumber: 'E1', type: 'premium', monthlyRent: MARKET_CONFIG.PREMIUM_STALL_RENT },
    { id: 'rent_E2', stallNumber: 'E2', type: 'premium', monthlyRent: MARKET_CONFIG.PREMIUM_STALL_RENT },
    { id: 'rent_F1', stallNumber: 'F1', type: 'basic',   monthlyRent: MARKET_CONFIG.BASIC_STALL_RENT },
    { id: 'rent_F2', stallNumber: 'F2', type: 'basic',   monthlyRent: MARKET_CONFIG.BASIC_STALL_RENT },
    { id: 'rent_F3', stallNumber: 'F3', type: 'basic',   monthlyRent: MARKET_CONFIG.BASIC_STALL_RENT }
];

// GET all stalls (gov + player rented)
app.get('/api/market/stalls', (req, res) => {
    const rentedStalls = Object.values(playerStalls);
    res.json({
        success:      true,
        govStalls:    GOV_STALLS,
        playerStalls: rentedStalls,
        rentalSpots:  RENTAL_SPOTS.map(spot => ({
            ...spot,
            isOccupied: !!playerStalls[spot.id]
        })),
        config:       MARKET_CONFIG
    });
});

// GET single stall details
app.get('/api/market/stall/:stallId', (req, res) => {
    const { stallId } = req.params;
    const govStall    = GOV_STALLS.find(s => s.id === stallId);
    const playerStall = playerStalls[stallId];
    const stall       = govStall || playerStall;

    if (!stall) return res.json({ success: false, message: 'Stall not found.' });
    res.json({ success: true, stall });
});

// POST — buy item from stall (with haggle support)
app.post('/api/market/buy', async (req, res) => {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res.json({ success: false, message: 'Sign in to buy.' });

    const { stallId, itemId, offeredPrice } = req.body;

    try {
        const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
        if (error || !user) return res.json({ success: false, message: 'Invalid session.' });

        // Find the stall and item
        const stall = GOV_STALLS.find(s => s.id === stallId)
                   || playerStalls[stallId];
        if (!stall) return res.json({ success: false, message: 'Stall not found.' });

        const item = stall.items.find(i => i.id === itemId);
        if (!item) return res.json({ success: false, message: 'Item not found.' });
        if (item.stock <= 0) return res.json({ success: false, message: 'Item out of stock!' });

        // Determine final price after haggle
        const askingPrice = offeredPrice || item.price;
        const minPrice    = Math.floor(item.price * MARKET_CONFIG.HAGGLE_MIN_PCT);

        let finalPrice    = item.price;
        let vendorResponse = '';
        let haggleResult  = 'accepted';

        if (offeredPrice && offeredPrice < item.price) {
            if (offeredPrice < minPrice) {
                // Offer too low — vendor rejects
                haggleResult   = 'rejected';
                vendorResponse = getVendorReject(stall.personality, item.name, item.price);
                return res.json({
                    success:       false,
                    haggleResult,
                    vendorResponse,
                    minPrice,
                    message:       vendorResponse
                });
            } else {
                // Vendor meets in the middle
                finalPrice     = Math.floor((offeredPrice + item.price) / 2);
                haggleResult   = 'countered';
                vendorResponse = getVendorCounter(stall.personality, finalPrice);
            }
        }

        // Get player balance
        const { data: player } = await supabaseAdmin
            .from('players')
            .select('naira_balance, stamina, health_status, attr_speed')
            .eq('user_id', user.id)
            .single();

        if (!player) return res.json({ success: false, message: 'Player not found.' });
        if (player.naira_balance < finalPrice)
            return res.json({
                success: false,
                message: `Not enough Naira! You need ₦${finalPrice.toLocaleString()}.`
            });

        // Apply item effect
        const updates    = { naira_balance: player.naira_balance - finalPrice };
        let effectMessage = '';

        if (item.effect.includes('stamina')) {
            const match    = item.effect.match(/stamina\+(\d+)/);
            const restore  = match ? parseInt(match[1]) : 0;
            updates.stamina = Math.min(100, (player.stamina || 100) + restore);
            effectMessage  += `⚡ Stamina +${restore}% (now ${updates.stamina}%). `;
        }
        if (item.effect.includes('health')) {
            updates.health_status = 'Healthy';
            effectMessage += `💊 Health restored to Healthy. `;
        }
        if (item.effect.includes('speed')) {
            const match   = item.effect.match(/speed\+(\d+)/);
            const boost   = match ? parseInt(match[1]) : 0;
            updates.attr_speed = Math.min(99, (player.attr_speed || 10) + boost);
            effectMessage += `💨 Speed +${boost} (now ${updates.attr_speed}). `;
        }
        if (item.effect.includes('kit')) {
            updates.kit_status = 'CustomJersey';
            effectMessage += `👕 Kit upgraded! `;
        }

        // Update player in database
        await supabaseAdmin.from('players').update(updates).eq('user_id', user.id);

        // Reduce stock for player stalls
        if (playerStalls[stallId]) {
            item.stock--;
        }

        const acceptMsg = haggleResult === 'countered'
            ? `Deal at ₦${finalPrice.toLocaleString()}! ${getVendorAccept(stall.personality)}`
            : getVendorAccept(stall.personality);

        console.log(`🏪 Purchase: ${item.name} for ₦${finalPrice.toLocaleString()} by user ${user.id}`);

        return res.json({
            success:        true,
            haggleResult:   haggleResult === 'countered' ? 'deal' : 'accepted',
            finalPrice,
            vendorResponse: acceptMsg,
            effectMessage,
            newBalance:     updates.naira_balance,
            newStamina:     updates.stamina,
            newSpeed:       updates.attr_speed,
            item
        });

    } catch (err) {
        console.error('Market buy error:', err);
        return res.json({ success: false, message: 'Server error.' });
    }
});

// POST — rent a stall
app.post('/api/market/rent', async (req, res) => {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res.json({ success: false, message: 'Sign in to rent a stall.' });

    const { spotId, stallName, items } = req.body;

    try {
        const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
        if (error || !user) return res.json({ success: false, message: 'Invalid session.' });

        const spot = RENTAL_SPOTS.find(s => s.id === spotId);
        if (!spot) return res.json({ success: false, message: 'Rental spot not found.' });
        if (playerStalls[spotId]) return res.json({ success: false, message: 'This stall is already rented.' });

        const { data: player } = await supabaseAdmin
            .from('players')
            .select('naira_balance, username')
            .eq('user_id', user.id)
            .single();

        if (!player) return res.json({ success: false, message: 'Player not found.' });
        if (player.naira_balance < spot.monthlyRent)
            return res.json({
                success: false,
                message: `Not enough Naira! Rent is ₦${spot.monthlyRent.toLocaleString()}/month.`
            });

        // Deduct rent
        await supabaseAdmin
            .from('players')
            .update({ naira_balance: player.naira_balance - spot.monthlyRent })
            .eq('user_id', user.id);

        // Create the player stall
        playerStalls[spotId] = {
            id:          spotId,
            stallNumber: spot.stallNumber,
            type:        'player',
            vendorName:  player.username,
            stallName:   stallName || `${player.username}'s Stall`,
            category:    'Mixed',
            personality: 'player',
            greeting:    `Welcome to ${stallName || player.username + "'s stall"}! What do you need?`,
            ownerId:     user.id,
            items:       items || [],
            rentedAt:    new Date().toISOString(),
            rentExpiry:  new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
        };

        console.log(`🏪 Stall rented: ${spot.stallNumber} by ${player.username}`);

        return res.json({
            success:    true,
            stall:      playerStalls[spotId],
            newBalance: player.naira_balance - spot.monthlyRent,
            message:    `Stall ${spot.stallNumber} rented! ₦${spot.monthlyRent.toLocaleString()} deducted.`
        });

    } catch (err) {
        console.error('Rent error:', err);
        return res.json({ success: false, message: 'Server error.' });
    }
});

// POST — add item to your stall
app.post('/api/market/stall/additem', async (req, res) => {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res.json({ success: false, message: 'Not authorised.' });

    const { spotId, item } = req.body;

    try {
        const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
        if (error || !user) return res.json({ success: false, message: 'Invalid session.' });

        const stall = playerStalls[spotId];
        if (!stall) return res.json({ success: false, message: 'Stall not found.' });
        if (stall.ownerId !== user.id) return res.json({ success: false, message: 'This is not your stall.' });

        stall.items.push({
            id:          item.id || `item_${Date.now()}`,
            name:        String(item.name).replace(/[<>'"]/g, '').trim(),
            price:       Math.max(1, parseInt(item.price) || 100),
            stock:       Math.max(1, parseInt(item.stock) || 10),
            effect:      item.effect || 'none',
            description: String(item.description || '').replace(/[<>'"]/g, '').trim()
        });

        return res.json({ success: true, stall, message: 'Item added to your stall!' });
    } catch (err) {
        return res.json({ success: false, message: 'Server error.' });
    }
});

// ============================================
// VENDOR DIALOGUE HELPERS
// ============================================
function getVendorReject(personality, itemName, price) {
    const responses = {
        warm:         `Ehhh my pikin! ₦${price.toLocaleString()} is already my last price. I no fit go lower than that o!`,
        hype:         `Guy abeg! That price wey you talk, e no make sense at all. Come with better offer!`,
        motherly:     `Haba! You wan make me lose money? That one no possible. The price is the price!`,
        salesman:     `Oga! You dey price Aba quality like common market? Come back with serious money!`,
        creative:     `My friend! This na handwork o. The price wey you offer, e no reach half the effort!`,
        professional: `I'm sorry, that offer is below our minimum. We cannot accept that price.`,
        player:       `That price too low abeg. Make we do better.`
    };
    return responses[personality] || responses.warm;
}

function getVendorCounter(personality, counterPrice) {
    const responses = {
        warm:         `Okay my pikin, because you be my customer — I go do ₦${counterPrice.toLocaleString()}. That's my final!`,
        hype:         `Okay okay! I like your energy. ₦${counterPrice.toLocaleString()} — we go settle there!`,
        motherly:     `Ah, you don beg me well well. Okay — ₦${counterPrice.toLocaleString()}. But tell your friends about my buka o!`,
        salesman:     `See, I like you. ₦${counterPrice.toLocaleString()} and we done. Shake body!`,
        creative:     `Fine! ₦${counterPrice.toLocaleString()}. But only because I want you to look sharp on the pitch!`,
        professional: `We can meet at ₦${counterPrice.toLocaleString()}. That is our best offer.`,
        player:       `Okay, ₦${counterPrice.toLocaleString()}. Deal?`
    };
    return responses[personality] || responses.warm;
}

function getVendorAccept(personality) {
    const responses = {
        warm:         'Thank you my pikin! God go bless you. Come back soon!',
        hype:         'Aye! Transaction complete! You go perform well today!',
        motherly:     'Take am! Chop well and play well. I dey pray for you!',
        salesman:     'Business done! Come back when you need more. I get plenty stock!',
        creative:     'Enjoy am! You go look sharp on that pitch. My work never fail!',
        professional: 'Thank you for your purchase. Please come again.',
        player:       'Thanks! Good luck out there!'
    };
    return responses[personality] || responses.warm;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 AGBA BALLER Server on port ${PORT}`);
    console.log(`💰 Goal:+₦${NAIRA_REWARDS.GOAL} | OwnGoal:-₦${Math.abs(NAIRA_REWARDS.OWN_GOAL_PENALTY)} | Win:+₦${NAIRA_REWARDS.WIN} | Draw:+₦${NAIRA_REWARDS.DRAW}`);
});