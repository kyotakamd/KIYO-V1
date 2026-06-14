const { 
    makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    makeInMemoryStore,
    downloadContentFromMessage
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');

// --- ⚠️ CONFIGURATION DE VOTRE NUMÉRO ---
// Mettez votre numéro AVEC l'indicatif pays, SANS le signe "+", SANS espaces et SANS tirets.
// Exemple pour la France : '33612345678'
const VOTRE_NUMERO = '509 4370-0315'; 

const store = makeInMemoryStore({ logger: pino().child({ level: 'silent', stream: 'store' }) });

async function startKiyoBot() {
    const { state, saveCreds } = await useMultiFileAuthState('kiyo_session');

    const kiyo = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false, // Indispensable pour utiliser le code texte à la place
        auth: state,
        // Un navigateur valide est obligatoire pour que l'association par code fonctionne
        browser: ['Ubuntu', 'Chrome', '20.0.04'] 
    });

    store.bind(kiyo.ev);

    // Demande du code d'association textuel si l'appareil n'est pas encore enregistré
    if (!kiyo.authState.creds.registered) {
        setTimeout(async () => {
            try {
                let code = await kiyo.requestPairingCode(VOTRE_NUMERO);
                // Formate le code pour le rendre plus lisible (Ex: XXXXXXXX -> XXXX-XXXX)
                code = code?.match(/.{1,4}/g)?.join('-') || code;
                console.log('\n╔════════════════════════════════════╗');
                console.log(`  🤖 KIYO V1 : VOTRE CODE EST : ${code}`);
                console.log('╚════════════════════════════════════╝\n');
                console.log('👉 Entrez ce code dans les notifications de votre téléphone ou dans :');
                console.log('   WhatsApp -> Appareils connectés -> Connecter un appareil -> Lier avec le numéro de téléphone.');
            } catch (error) {
                console.error('Erreur lors de la génération du code :', error);
            }
        }, 3000); // Petit délai pour laisser le socket s'initialiser correctement
    }

    kiyo.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connexion perdue. Reconnexion...', shouldReconnect);
            if (shouldReconnect) startKiyoBot();
        } else if (connection === 'open') {
            console.log('\n🤖 BOT KIYO V1 DÉMARRÉ ET CONNECTÉ PAR CODE AVEC SUCCÈS !');
        }
    });

    kiyo.ev.on('creds.update', saveCreds);

    // --- ANALYSE DES MESSAGES (MÊME LOGIQUE QUE LE SCRIPT PRÉCÉDENT) ---
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
            else if (type === 'imageMessage') body = mek.message.imageMessage.caption;
            else if (type === 'videoMessage') body = mek.message.videoMessage.caption;

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
                    reply(`╔════════════════╗\n  *🤖 KIYO-MD V1 BOT* \n╚════════════════╝\n\n*Prefix* : [  ${prefix}  ]\n\n*┌ 👤 MENU*\n│ 📋 ${prefix}menu\n│ ⚡ ${prefix}ping\n└═════════════════\n\n*┌ 🎨 CRÉATION*\n│ 🗿 ${prefix}sticker _(sur image)_\n└═════════════════\n\n*┌ 👥 GROUPES*\n│ 📢 ${prefix}tagall\n│ 🥾 ${prefix}kick @user\n└═════════════════`);
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

                case 'sticker':
                case 's':
                    const isQuotedImage = type === 'extendedTextMessage' && mek.message.extendedTextMessage.contextInfo?.quotedMessage?.imageMessage;
                    const isImage = type === 'imageMessage';

                    if (isImage || isQuotedImage) {
                        reply('Création du sticker... ⏳');
                        const targetMessage = isImage ? mek.message.imageMessage : mek.message.extendedTextMessage.contextInfo.quotedMessage.imageMessage;
                        const stream = await downloadContentFromMessage(targetMessage, 'image');
                        let buffer = Buffer.from([]);
                        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

                        const filename = `./kiyo_${Date.now()}`;
                        fs.writeFileSync(`${filename}.jpg`, buffer);

                        ffmpeg(`${filename}.jpg`)
                            .inputOptions(['-vcodec', 'mjpeg'])
                            .outputOptions(['-vcodec', 'libwebp', '-vf', "scale='min(320,iw)':min'(320,ih)':force_original_aspect_ratio=decrease,fps=15, pad=320:320:-1:-1:color=white@0.0, split [a][b]; [a] palettegen=reserve_transparent=on:transparency_color=ffffff [p]; [b][p] paletteuse"])
                            .toFormat('webp')
                            .save(`${filename}.webp`)
                            .on('end', async () => {
                                await kiyo.sendMessage(from, { sticker: fs.readFileSync(`${filename}.webp`) }, { quoted: mek });
                                fs.unlinkSync(`${filename}.jpg`);
                                fs.unlinkSync(`${filename}.webp`);
                            })
                            .on('error', () => reply('Erreur conversion. Vérifiez FFmpeg.'));
                    } else {
                        reply('Répondez à une image avec *.sticker*');
                    }
                    break;
            }
        } catch (err) {
            console.error(err);
        }
    });
}

startKiyoBot();

