const { 
    makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    makeInMemoryStore
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');

// --- SERVEUR EXPRESS OBLIGATOIRE POUR RENDER ---
const app = express();
app.get('/', (req, res) => res.send('🤖 KIYO V1 est en ligne et actif !'));
app.listen(process.env.PORT || 3000, () => console.log('Web Service démarré.'));

// --- CONFIGURATION DE VOTRE NUMÉRO ---
const VOTRE_NUMERO = '50943700315'; 

const store = makeInMemoryStore({ logger: pino().child({ level: 'silent', stream: 'store' }) });

async function startKiyoBot() {
    const { state, saveCreds } = await useMultiFileAuthState('kiyo_session');

    const kiyo = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false, 
        auth: state,
        browser: ['Ubuntu', 'Chrome', '20.0.04'] 
    });

    store.bind(kiyo.ev);

    if (!kiyo.authState.creds.registered) {
        setTimeout(async () => {
            try {
                let code = await kiyo.requestPairingCode(VOTRE_NUMERO);
                code = code?.match(/.{1,4}/g)?.join('-') || code;
                console.log('\n╔════════════════════════════════════╗');
                console.log(`  🤖 KIYO V1 : VOTRE CODE EST : ${code}`);
                console.log('╚════════════════════════════════════╝\n');
            } catch (error) {
                console.error('Erreur lors de la génération du code :', error);
            }
        }, 3000);
    }

    kiyo.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connexion perdue. Reconnexion...', shouldReconnect);
            if (shouldReconnect) startKiyoBot();
        } else if (connection === 'open') {
            console.log('\n🤖 BOT KIYO V1 CONNECTÉ AVEC SUCCÈS !');
        }
    });

    kiyo.ev.on('creds.update', saveCreds);

    kiyo.ev.on('messages.upsert', async (chatUpdate) => {
        try {
            const mek = chatUpdate.messages;
            if (!mek || !mek.message) return;
            if (mek.key.fromMe) return;

            const from = mek.key.remoteJid;
            const type = Object.keys(mek.message);
            
            let body = '';
            if (type === 'conversation') body = mek.message.conversation;
            else if (type === 'extendedTextMessage') body = mek.message.extendedTextMessage.text;

            const prefix = /^[°•π÷×¶∆£¢€¥®™✓_=|~!?#./^%_+&:-]/.test(body) ? body.match(/^[°•π÷×¶∆£¢€¥®™✓_=|~!?#./^%_+&:-]/) : '';
            const isCmd = body.startsWith(prefix);
            const command = isCmd ? body.slice(prefix.length).trim().split(/ +/).shift().toLowerCase() : '';
            const args = body.trim().split(/ +/).slice(1);
            const text = args.join(' ');

            const isGroup = from.endsWith('@g.us');
            const sender = isGroup ? mek.key.participant : from;
            
            let groupMetadata = isGroup ? await kiyo.groupMetadata(from) : '';
            let groupMembers = isGroup ? groupMetadata.participants : [];
            let groupAdmins = isGroup ? groupMembers.filter(v => v.admin !== null).map(v => v.id) : [];
            
            const isBotAdmin = isGroup ? groupAdmins.includes(kiyo.user.id.split(':') + '@s.whatsapp.net') : false;
            const isAdmin = isGroup ? groupAdmins.includes(sender) : false;

            const reply = (txt) => {
                kiyo.sendMessage(from, { text: txt }, { quoted: mek });
            };

            // Anti-Link
            if (isGroup && isBotAdmin && body.includes('://whatsapp.com') && !isAdmin) {
                await kiyo.sendMessage(from, { delete: mek.key });
                await kiyo.groupParticipantsUpdate(from, [sender], 'remove');
                return reply(`🚫 *Anti-Link actif !* Un membre a été banni.`);
            }

            if (!isCmd) return;

            switch (command) {
                case 'ping':
                    reply('Pong ! Vitesse de réponse optimale. ⚡');
                    break;

                case 'menu':
                case 'help':
                    reply(`╔════════════════╗\n  *🤖 KIYO-MD V1 BOT* \n╚════════════════╝\n\n*Prefix* : [  ${prefix}  ]\n\n*┌ 👤 MENU*\n│ 📋 ${prefix}menu\n│ ⚡ ${prefix}ping\n└═════════════════\n\n*┌ 👥 GROUPES*\n│ 📢 ${prefix}tagall\n│ 🥾 ${prefix}kick @user\n└═════════════════`);
                    break;

                case 'tagall':
                    if (!isGroup || !isAdmin) return;
                    let tagText = `📢 *Mention Générale* : ${text}\n\n`;
                    let mentions = [];
                    for (let mem of groupMembers) {
                        tagText += `👥 @${mem.id.split('@')}\n`;
                        mentions.push(mem.id);
                    }
                    kiyo.sendMessage(from, { text: tagText, mentions: mentions }, { quoted: mek });
                    break;

                case 'kick':
                    if (!isGroup || !isBotAdmin || !isAdmin) return;
                    let usersToKick = mek.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
                    if (usersToKick.length === 0) return reply('Mentionnez l\'utilisateur à expulser !');
                    await kiyo.groupParticipantsUpdate(from, usersToKick, 'remove');
                    reply(`🥾 Membre expulsé.`);
                    break;
            }
        } catch (err) {
            console.error(err);
        }
    });
}

startKiyoBot();

