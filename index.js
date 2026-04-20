const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');

// 🔐 Firebase URL from GitHub Secrets
const FIREBASE_URL = process.env.FIREBASE_URL;

const orderStates = {};

// ✅ SAFE FETCH FUNCTION (FIXES YOUR ERROR)
async function getMenuFromApp() {
    try {
        const response = await fetch(`${FIREBASE_URL}/dishes.json`);

        const text = await response.text(); // 👈 IMPORTANT

        try {
            const data = JSON.parse(text);

            if (!data) return [];

            return Object.keys(data).map(key => ({
                id: key,
                name: data[key].name,
                price: data[key].price,
                imageUrl: data[key].imageUrl
            }));
        } catch (err) {
            console.error("❌ Firebase returned HTML instead of JSON:");
            console.error(text.substring(0, 200));
            return [];
        }

    } catch (error) {
        console.error("❌ Fetch Error:", error);
        return [];
    }
}

async function startBot() {
    if (!FIREBASE_URL) {
        console.log("❌ ERROR: FIREBASE_URL missing!");
        process.exit(1);
    }

    const { state, saveCreds } = await useMultiFileAuthState('session_data');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ["RKK", "Bot", "1.0"]
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.clear();
            console.log("📱 Scan QR:");
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') console.log('✅ RKK AI IS ONLINE!');

        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log("❌ Connection closed. Reconnecting...");
            if (reason !== DisconnectReason.loggedOut) startBot();
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;
            if (msg.key.fromMe) return;

            const sender = msg.key.remoteJid;
            const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim().toLowerCase();

            console.log(`📩 ${sender}: ${text}`);

            // ============================
            // ✅ STEP 2: ADDRESS + ORDER
            // ============================
            if (orderStates[sender]?.step === 'WAITING_FOR_ADDRESS') {

                const details = text.split(",");

                if (details.length < 3) {
                    await sock.sendMessage(sender, {
                        text: "❌ Please send correctly:\n\nName, Phone, Address"
                    });
                    return;
                }

                const [name, phone, address] = details.map(d => d.trim());

                // ✅ Phone validation
                const phoneRegex = /^[6-9]\d{9}$/;

                if (!phoneRegex.test(phone)) {
                    await sock.sendMessage(sender, {
                        text: "❌ Invalid phone number\nExample: 9876543210"
                    });
                    return;
                }

                const item = orderStates[sender].item;
                const waNumber = sender.split('@')[0];

                const orderData = {
                    userId: "whatsapp_" + waNumber,
                    phone,
                    name,
                    address,
                    items: [{
                        id: item.id,
                        name: item.name,
                        price: parseFloat(item.price),
                        img: item.imageUrl || "",
                        quantity: 1
                    }],
                    total: (parseFloat(item.price) + 50).toFixed(2),
                    status: "Placed",
                    method: "COD",
                    timestamp: new Date().toISOString()
                };

                try {
                    await fetch(`${FIREBASE_URL}/orders.json`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(orderData)
                    });

                    await sock.sendMessage(sender, {
                        text: `✅ *Order Confirmed!*\n\n🍽 ${item.name}\n💰 ₹${orderData.total}\n📍 ${address}\n\n🚚 Status: Preparing`
                    });

                } catch (err) {
                    console.log("❌ Order Save Error:", err);
                    await sock.sendMessage(sender, {
                        text: "❌ Failed to place order. Try again."
                    });
                }

                delete orderStates[sender];
                return;
            }

            // ============================
            // 🛒 STEP 1: ORDER START
            // ============================
            if (text.startsWith("order ")) {

                const productRequested = text.replace("order ", "").trim();
                const menu = await getMenuFromApp();

                const item = menu.find(i =>
                    i.name.toLowerCase().includes(productRequested)
                );

                if (!item) {
                    await sock.sendMessage(sender, {
                        text: `❌ Item not found: ${productRequested}\nType *menu*`
                    });
                    return;
                }

                orderStates[sender] = {
                    step: "WAITING_FOR_ADDRESS",
                    item
                };

                const msgText = `🛒 *${item.name}* (₹${item.price})\n\nSend:\nName, Phone, Address`;

                if (item.imageUrl) {
                    await sock.sendMessage(sender, {
                        image: { url: item.imageUrl },
                        caption: msgText
                    });
                } else {
                    await sock.sendMessage(sender, { text: msgText });
                }
            }

            // ============================
            // 📋 MENU
            // ============================
            else if (text.includes("menu")) {

                const menu = await getMenuFromApp();

                if (menu.length === 0) {
                    await sock.sendMessage(sender, {
                        text: "⚠️ Menu not available"
                    });
                    return;
                }

                let msgText = "🍔 *RKK MENU*\n\n";

                menu.forEach(i => {
                    msgText += `🔸 ${i.name} - ₹${i.price}\n`;
                });

                msgText += "\n👉 order pizza";

                await sock.sendMessage(sender, { text: msgText });
            }

            // ============================
            // 👋 GREETING
            // ============================
            else if (text.match(/hi|hello|hey/)) {
                await sock.sendMessage(sender, {
                    text: "👋 Welcome to RKK!\nType *menu*"
                });
            }

            // ============================
            // ❓ DEFAULT
            // ============================
            else {
                await sock.sendMessage(sender, {
                    text: "❓ Type *menu* to start"
                });
            }

        } catch (err) {
            console.log("❌ Message Error:", err);
        }
    });
}

startBot();
