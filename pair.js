import express from 'express';
import fs from 'fs';
import pino from 'pino';
import { makeWASocket, useMultiFileAuthState, delay, makeCacheableSignalKeyStore, Browsers, jidNormalizedUser, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pn from 'awesome-phonenumber';
import { pairingSessions } from './sessionStore.js';

const router = express.Router();

// Ensure the session directory exists
function removeFile(FilePath) {
    try {
        if (!fs.existsSync(FilePath)) return false;
        fs.rmSync(FilePath, { recursive: true, force: true });
    } catch (e) {
        console.error('Error removing file:', e);
    }
}

router.get('/', async (req, res) => {
    let num = req.query.number;
    const sessionId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
    const dirs = './qr_sessions/session_' + sessionId;
    let isLinked = false;
    let reconnectAttempts = 0;
    const maxReconnectAttempts = 3;

    // Ensure qr_sessions directory exists
    if (!fs.existsSync('./qr_sessions')) {
        fs.mkdirSync('./qr_sessions', { recursive: true });
    }

    // Initialize session state
    pairingSessions.set(sessionId, {
        status: 'pending',
        code: null,
        sessionID: null,
        error: null,
        sock: null,
        _ts: Date.now()
    });

    const sessionStoreEntry = pairingSessions.get(sessionId);

    // Clean the phone number - remove any non-digit characters
    num = num.replace(/[^0-9]/g, '');

    // Validate the phone number using awesome-phonenumber
    const phone = pn('+' + num);
    if (!phone.isValid()) {
        sessionStoreEntry.status = 'error';
        sessionStoreEntry.error = 'Invalid phone number';
        if (!res.headersSent) {
            return res.status(400).send({ code: 'Invalid phone number. Please enter your full international number (e.g., 15551234567 for US, 447911123456 for UK, 84987654321 for Vietnam, etc.) without + or spaces.' });
        }
        return;
    }
    // Use the international number format (E.164, without '+')
    num = phone.getNumber('e164').replace('+', '');

    async function initiateSession() {
        const { state, saveCreds } = await useMultiFileAuthState(dirs);

        try {
            const { version, isLatest } = await fetchLatestBaileysVersion();
            let OxBot = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
                },
                printQRInTerminal: false,
                logger: pino({ level: "fatal" }).child({ level: "fatal" }),
                browser: Browsers.windows('Chrome'),
                markOnlineOnConnect: false,
                generateHighQualityLinkPreview: false,
                defaultQueryTimeoutMs: 60000,
                connectTimeoutMs: 60000,
                keepAliveIntervalMs: 30000,
                retryRequestDelayMs: 250,
                maxRetries: 5,
            });

            sessionStoreEntry.sock = OxBot;

            OxBot.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, isNewLogin, isOnline } = update;

                if (connection === 'open') {
                    console.log("✅ Connected successfully!");
                    console.log("📱 Sending session ID to user...");
                    isLinked = true;
                    
                    try {
                        const sessionContent = fs.readFileSync(dirs + '/creds.json', 'utf8');
                        const b64 = Buffer.from(sessionContent).toString('base64');
                        const sessionName = 'oxbot_' + num;
                        const fullSession = sessionName + '::::' + b64;

                        // Save the generated session to session store
                        sessionStoreEntry.status = 'linked';
                        sessionStoreEntry.sessionID = fullSession;

                        // Send session ID to user
                        const userJid = jidNormalizedUser(num + '@s.whatsapp.net');
                        await OxBot.sendMessage(userJid, { text: fullSession });
                        console.log("📄 Session ID sent successfully");

                        await delay(1500);

                        // Send warning/instructions message
                        const instructions = `⚠️ *Do not share this session ID with anyone.*\n\nCopy the raw Session ID message above and paste it in your OxBot dashboard to connect your bot.`;
                        await OxBot.sendMessage(userJid, { text: instructions });
                        console.log("⚠️ Warning message sent successfully");

                        // Clean up session after use
                        console.log("🧹 Cleaning up session...");
                        await delay(4000);
                        try { OxBot.ws?.close(); } catch {}
                        try { OxBot.end(); } catch {}
                        removeFile(dirs);
                        pairingSessions.delete(sessionId);
                        console.log("✅ Session cleaned up successfully");
                        console.log("🎉 Process completed successfully!");
                        // Do not exit the process, just finish gracefully
                    } catch (error) {
                        console.error("❌ Error sending messages:", error);
                        // Still clean up session even if sending fails
                        try { OxBot.ws?.close(); } catch {}
                        try { OxBot.end(); } catch {}
                        removeFile(dirs);
                        sessionStoreEntry.status = 'error';
                        sessionStoreEntry.error = error.message;
                        pairingSessions.delete(sessionId);
                        // Do not exit the process, just finish gracefully
                    }
                }

                if (isNewLogin) {
                    console.log("🔐 New login via pair code");
                }

                if (isOnline) {
                    console.log("📶 Client is online");
                }

                if (connection === 'close') {
                    if (isLinked) {
                        console.log("ℹ️ Connection closed gracefully after successful link.");
                        return;
                    }
                    const statusCode = lastDisconnect?.error?.output?.statusCode;

                    if (statusCode === 401 || statusCode === 408) {
                        console.log(`❌ Pairing socket stopped (code: ${statusCode}).`);
                        sessionStoreEntry.status = 'error';
                        sessionStoreEntry.error = `Socket stopped (code: ${statusCode})`;
                        try { OxBot.ws?.close(); } catch {}
                        try { OxBot.end(); } catch {}
                        removeFile(dirs);
                        pairingSessions.delete(sessionId);
                    } else if (reconnectAttempts < maxReconnectAttempts) {
                        reconnectAttempts++;
                        console.log(`🔁 Connection closed — restarting (Attempt ${reconnectAttempts}/${maxReconnectAttempts})...`);
                        initiateSession();
                    } else {
                        console.log("❌ Max reconnect attempts reached. Stopping pairing socket.");
                        sessionStoreEntry.status = 'error';
                        sessionStoreEntry.error = 'Max reconnect attempts reached';
                        try { OxBot.ws?.close(); } catch {}
                        try { OxBot.end(); } catch {}
                        removeFile(dirs);
                        pairingSessions.delete(sessionId);
                    }
                }
            });

            if (!OxBot.authState.creds.registered) {
                await delay(3000); // Wait 3 seconds before requesting pairing code
                num = num.replace(/[^\d+]/g, '');
                if (num.startsWith('+')) num = num.substring(1);

                try {
                    let code = await OxBot.requestPairingCode(num);
                    code = code?.match(/.{1,4}/g)?.join('-') || code;
                    
                    sessionStoreEntry.status = 'code_ready';
                    sessionStoreEntry.code = code;

                    if (!res.headersSent) {
                        console.log({ num, code });
                        await res.send({ code, id: sessionId });
                    }
                } catch (error) {
                    console.error('Error requesting pairing code:', error);
                    sessionStoreEntry.status = 'error';
                    sessionStoreEntry.error = 'Failed to request pairing code';
                    if (!res.headersSent) {
                        res.status(503).send({ code: 'Failed to get pairing code. Please check your phone number and try again.' });
                    }
                }
            }

            OxBot.ev.on('creds.update', saveCreds);
        } catch (err) {
            console.error('Error initializing session:', err);
            sessionStoreEntry.status = 'error';
            sessionStoreEntry.error = 'Service Unavailable';
            if (!res.headersSent) {
                res.status(503).send({ code: 'Service Unavailable' });
            }
        }
    }

    await initiateSession();
});

// Global uncaught exception handler
process.on('uncaughtException', (err) => {
    let e = String(err);
    if (e.includes("conflict")) return;
    if (e.includes("not-authorized")) return;
    if (e.includes("Socket connection timeout")) return;
    if (e.includes("rate-overlimit")) return;
    if (e.includes("Connection Closed")) return;
    if (e.includes("Timed Out")) return;
    if (e.includes("Value not found")) return;
    if (e.includes("Stream Errored")) return;
    if (e.includes("Stream Errored (restart required)")) return;
    if (e.includes("statusCode: 515")) return;
    if (e.includes("statusCode: 503")) return;
    console.log('Caught exception: ', err);
});

export default router;