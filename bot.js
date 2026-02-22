// === CONFIG - EDIT THESE ===
const MC_HOST = 'YOUR_SERVER_IP';
const MC_PORT = 25565;
const MC_USERNAME = 'YOUR_USERNAME';
const MC_VERSION = false; // false = auto

const DISCORD_TOKEN = 'YOUR_DISCORD_BOT_TOKEN';
const CHANNEL_ID = 'YOUR_CHAT_RELAY_CHANNEL_ID';          // where MC <-> Discord chat happens
const PLAYER_ALERT_CHANNEL_ID = 'YOUR_ALERT_CHANNEL_ID';  // player enter/leave
const COMMAND_CHANNEL_ID = 'YOUR_COMMAND_CHANNEL_ID';     // !pathto !follow etc

const RENDER_DISTANCE = 32;
const FLY_DURATION = 10; // sec for smooth fly to target
// === END CONFIG ===

const mineflayer = require('mineflayer');
const { Client, GatewayIntentBits, Events } = require('discord.js');
const pathfinder = require('mineflayer-pathfinder').pathfinder;
const Movements = require('mineflayer-pathfinder').Movements;
const { GoalBlock, GoalFollow } = require('mineflayer-pathfinder').goals;
const Vec3 = require('vec3').Vec3;

let mcBot;
let nearbyPlayers = new Set();
let isDead = false;
let discordClient = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

let reconnectTimeout;

discordClient.once(Events.ClientReady, () => {
    console.log('Discord connected fr');
});

discordClient.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;

    const content = message.content.trim();
    if (!content) return;

    if (message.channel.id === CHANNEL_ID) {
        // Relay your discord msg to MC clean
        mcBot.chat(content);

        // Show in discord exactly like MC style: username: message
        const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
        const formatted = `${timestamp} ${message.author.username}: ${content}`;
        await message.channel.send(formatted);
    }
    else if (message.channel.id === COMMAND_CHANNEL_ID && content.startsWith('!')) {
        const args = content.slice(1).trim().split(/\s+/);
        const cmd = args.shift()?.toLowerCase();

        if (cmd === 'pathto') {
            if (args.length !== 3) return message.reply('!pathto x y z');
            const [x, y, z] = args.map(Number);
            if (isNaN(x) || isNaN(y) || isNaN(z)) return message.reply('bad coords bruh');
            mcBot.pathfinder.setGoal(new GoalBlock(x, y, z));
            message.reply(`pathin to ${x} ${y} ${z}`);
        }
        else if (cmd === 'follow') {
            if (!args[0]) return message.reply('!follow username');
            const targetName = args[0];
            const target = mcBot.players[targetName]?.entity;
            if (!target) return message.reply(`cant see ${targetName}`);
            mcBot.pathfinder.setGoal(new GoalFollow(target, 3));
            message.reply(`followin ${targetName}`);
        }
        else if (cmd === 'flyto') {
            if (args.length !== 3) return message.reply('!flyto x y z');
            const [x, y, z] = args.map(Number);
            if (isNaN(x) || isNaN(y) || isNaN(z)) return message.reply('bad coords');
            await smoothFly(x, y, z, FLY_DURATION);
            message.reply(`flew to ${x} ${y} ${z}`);
        }
        else if (cmd === 'stop') {
            mcBot.pathfinder.setGoal(null);
            message.reply('stopped movin');
        }
    }
});

async function loginDiscord() {
    try {
        await discordClient.login(DISCORD_TOKEN);
    } catch (e) {
        console.log('disc login fail, retryin 5s...', e.message);
        setTimeout(loginDiscord, 5000);
    }
}

function initBot(bot) {
    mcBot = bot;
    mcBot.loadPlugin(pathfinder);

    // NoFall godmode: force onGround false in every position packet
    const originalWrite = mcBot._client.write;
    mcBot._client.write = function (name, data) {
        if (name.startsWith('player_') && data?.onGround !== undefined) {
            data.onGround = false;
        }
        return originalWrite.call(this, name, data);
    };

    mcBot.on('login', () => {
        console.log('MC logged in');
        isDead = false;
        nearbyPlayers.clear();
    });

    mcBot.on('spawn', async () => {
        console.log('spawned');
        mcBot.setControlState('jump', false);
        mcBot.setControlState('sneak', false);

        const movements = new Movements(mcBot);
        movements.canDig = false;
        movements.allow1by1towers = false;
        mcBot.pathfinder.setMovements(movements);

        // Default fly to 0 420 0
        await smoothFly(0, 420, 0, FLY_DURATION);
    });

    mcBot.on('death', () => {
        isDead = true;
        console.log('died, respawnin...');
        setTimeout(() => mcBot.respawn(), 200);
    });

    mcBot.on('respawn', async () => {
        await new Promise(r => setTimeout(r, 1000));
        isDead = false;
        // spawn event will handle fly
    });

    // Player radar
    mcBot.on('entitySpawn', entity => {
        if (entity.type !== 'player' || entity.username === mcBot.username) return;
        const dist = mcBot.entity.position.distanceTo(entity.position);
        if (dist <= RENDER_DISTANCE && !nearbyPlayers.has(entity.username)) {
            nearbyPlayers.add(entity.username);
            discordClient.channels.cache.get(PLAYER_ALERT_CHANNEL_ID)?.send(
                `Player entered: \( {entity.username} ( \){dist.toFixed(1)} blocks)`
            );
        }
    });

    mcBot.on('entityGone', entity => {
        if (entity.type === 'player' && nearbyPlayers.has(entity.username)) {
            nearbyPlayers.delete(entity.username);
            discordClient.channels.cache.get(PLAYER_ALERT_CHANNEL_ID)?.send(
                `Player left: ${entity.username}`
            );
        }
    });

    mcBot.on('move', () => {
        if (!mcBot.entity) return;
        for (const name of [...nearbyPlayers]) {
            const p = mcBot.players[name];
            if (p?.position) {
                const dist = mcBot.entity.position.distanceTo(p.position);
                if (dist > RENDER_DISTANCE) {
                    nearbyPlayers.delete(name);
                    discordClient.channels.cache.get(PLAYER_ALERT_CHANNEL_ID)?.send(
                        `Player left: ${name} (moved away)`
                    );
                }
            } else {
                nearbyPlayers.delete(name);
            }
        }
    });

    // MC chat → Discord with timestamp + username: msg
    mcBot.on('chat', (username, message) => {
        if (username === mcBot.username) return;
        const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
        const formatted = `${timestamp} ${username}: ${message}`;
        discordClient.channels.cache.get(CHANNEL_ID)?.send(formatted);
    });

    mcBot.on('error', err => console.log('MC err:', err.message));
    mcBot.on('end', () => {
        console.log('MC dc - retry in 5s');
        nearbyPlayers.clear();
        clearTimeout(reconnectTimeout);
        reconnectTimeout = setTimeout(startBot, 5000);
    });
}

async function smoothFly(tx, ty, tz, duration) {
    const start = mcBot.entity.position;
    const steps = 120;
    const delay = (duration * 1000) / steps;

    console.log(`flyin to ${tx} ${ty} ${tz} in ${duration}s`);

    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const ease = t * t * (3 - 2 * t);
        const x = start.x + (tx - start.x) * ease;
        const y = start.y + (ty - start.y) * ease;
        const z = start.z + (tz - start.z) * ease;

        mcBot.entity.position = new Vec3(x, y, z);
        mcBot._client.write('position', { x, y, z, onGround: false });

        await new Promise(r => setTimeout(r, delay));
    }
}

function startBot() {
    const bot = mineflayer.createBot({
        host: MC_HOST,
        port: MC_PORT,
        username: MC_USERNAME,
        version: MC_VERSION
        auth: 'microsoft'
    });
    initBot(bot);
}

loginDiscord();
startBot();
console.log('bot goin up...');
