require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static assets directly from the root directory
app.use(express.static(__dirname));

// Route 1: Serve Main Game Page from root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Route 2: Serve Admin Radar Page from root
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// In-Memory Storage (Replace with DB for production)
const userBalances = {};

// Secret key for Admin Radar access
const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET_KEY || 'SUPER_SECRET_ADMIN_KEY';

// ==========================================
// 1. M-PESA DARAJA HELPER MIDDLEWARE
// ==========================================
async function getMpesaToken(req, res, next) {
    const consumerKey = process.env.MPESA_CONSUMER_KEY;
    const consumerSecret = process.env.MPESA_CONSUMER_SECRET;

    if (!consumerKey || !consumerSecret) {
        console.error("Missing M-Pesa API Keys in .env");
        return res.status(500).json({ error: "Server misconfiguration: Missing M-Pesa credentials." });
    }

    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
    const url = process.env.MPESA_ENV === 'live' 
        ? 'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials'
        : 'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials';

    try {
        const response = await axios.get(url, {
            headers: { Authorization: `Basic ${auth}` }
        });
        req.token = response.data.access_token;
        next();
    } catch (error) {
        console.error("M-Pesa Auth Error:", error.response?.data || error.message);
        res.status(500).json({ error: "Failed to authenticate with M-Pesa Daraja API." });
    }
}

// Generate Timestamp (YYYYMMDDHHmmss)
function getTimestamp() {
    const date = new Date();
    const YYYY = date.getFullYear();
    const MM = String(date.getMonth() + 1).padStart(2, '0');
    const DD = String(date.getDate()).padStart(2, '0');
    const HH = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    const ss = String(date.getSeconds()).padStart(2, '0');
    return `${YYYY}${MM}${DD}${HH}${mm}${ss}`;
}

// ==========================================
// 2. API ENDPOINTS
// ==========================================

// Initiate M-Pesa STK Push (Deposit)
app.post('/api/mpesa/stkpush', getMpesaToken, async (req, res) => {
    try {
        const { phone, amount, userId } = req.body;

        if (!phone || !amount) {
            return res.status(400).json({ error: "Phone number and amount are required." });
        }

        // Format Phone Number to 254XXXXXXXXX
        let formattedPhone = phone.trim().replace('+', '');
        if (formattedPhone.startsWith('0')) {
            formattedPhone = '254' + formattedPhone.slice(1);
        } else if (formattedPhone.startsWith('7') || formattedPhone.startsWith('1')) {
            formattedPhone = '254' + formattedPhone;
        }

        const timestamp = getTimestamp();
        const passkey = process.env.MPESA_PASSKEY;
        const shortcode = process.env.MPESA_SHORTCODE;
        const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');

        const stkUrl = process.env.MPESA_ENV === 'live'
            ? 'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest'
            : 'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest';

        const payload = {
            BusinessShortCode: shortcode,
            Password: password,
            Timestamp: timestamp,
            TransactionType: "CustomerPayBillOnline",
            Amount: Math.round(Number(amount)),
            PartyA: formattedPhone,
            PartyB: shortcode,
            PhoneNumber: formattedPhone,
            CallBackURL: process.env.MPESA_CALLBACK_URL,
            AccountReference: "SkyrushGame",
            TransactionDesc: `Deposit for user ${userId || formattedPhone}`
        };

        const response = await axios.post(stkUrl, payload, {
            headers: { Authorization: `Bearer ${req.token}` }
        });

        console.log("STK Push Initiated successfully:", response.data);
        res.status(200).json({ 
            success: true, 
            message: "STK Push prompt sent to your phone.", 
            data: response.data 
        });

    } catch (error) {
        console.error("STK Push Failed:", error.response?.data || error.message);
        res.status(500).json({ 
            error: "Failed to initiate STK Push.", 
            details: error.response?.data || error.message 
        });
    }
});

// FAKE WITHDRAWAL ENDPOINT
app.post('/api/mpesa/withdraw', (req, res) => {
    const { phone, amount } = req.body;

    if (!phone || !amount) {
        return res.status(400).json({ error: "Phone number and amount are required." });
    }

    const withdrawAmount = Number(amount);
    const currentBalance = userBalances[phone] || 0;

    if (currentBalance < withdrawAmount) {
        return res.status(400).json({ error: "Insufficient balance for withdrawal." });
    }

    // Deduct balance locally
    userBalances[phone] -= withdrawAmount;

    console.log(`⏳ Fake withdrawal requested: Phone ${phone}, Amount KES ${withdrawAmount}`);

    // Respond immediately to UI that request was accepted
    res.status(200).json({
        success: true,
        message: "Withdrawal request submitted successfully. Processing via M-Pesa...",
        newBalance: userBalances[phone]
    });

    // Simulate delayed success response (3 seconds later)
    setTimeout(() => {
        const fakeReceipt = 'WS' + Math.random().toString(36).substring(2, 10).toUpperCase();
        console.log(`✅ Fake Withdrawal Processed: KES ${withdrawAmount} sent to ${phone} (Ref: ${fakeReceipt})`);

        io.emit('withdraw_success', {
            phone,
            amount: withdrawAmount,
            receipt: fakeReceipt,
            newBalance: userBalances[phone]
        });
    }, 3000);
});

// M-Pesa Callback Endpoint (Webhook)
app.post('/api/mpesa/callback', (req, res) => {
    console.log("--- M-PESA CALLBACK RECEIVED ---");
    console.log(JSON.stringify(req.body, null, 2));

    const callbackData = req.body?.Body?.stkCallback;

    if (!callbackData) {
        return res.status(400).send("Invalid callback payload");
    }

    const resultCode = callbackData.ResultCode;
    const resultDesc = callbackData.ResultDesc;

    if (resultCode === 0) {
        const metadata = callbackData.CallbackMetadata.Item;
        const amountItem = metadata.find(item => item.Name === 'Amount');
        const mpesaReceiptItem = metadata.find(item => item.Name === 'MpesaReceiptNumber');
        const phoneItem = metadata.find(item => item.Name === 'PhoneNumber');

        const amount = amountItem ? amountItem.Value : 0;
        const receipt = mpesaReceiptItem ? mpesaReceiptItem.Value : '';
        const phone = phoneItem ? phoneItem.Value : '';

        console.log(`✅ Payment Successful! Phone: ${phone}, Amount: KES ${amount}, Receipt: ${receipt}`);

        // Update user balance in memory & notify frontend via Socket.io
        userBalances[phone] = (userBalances[phone] || 0) + amount;
        io.emit('deposit_success', { phone, amount, receipt, newBalance: userBalances[phone] });
    } else {
        console.log(`❌ Payment Failed/Cancelled: ${resultDesc} (Code: ${resultCode})`);
        io.emit('deposit_failed', { reason: resultDesc });
    }

    // Always respond 200 OK to Safaricom
    res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
});

// ==========================================
// 3. SKYRUSH GAME ENGINE (SOCKET.IO)
// ==========================================
let multiplier = 1.00;
let isCrashed = false;
let gameInterval = null;
let roundId = 0;

function startNewGameRound() {
    multiplier = 1.00;
    isCrashed = false;
    roundId++;
    
    // Crash point between 1.05x and 15.00x
    const crashPoint = parseFloat((Math.random() * (15 - 1.05) + 1.05).toFixed(2));
    console.log(`🎮 New Round #${roundId} Started. Will crash at: ${crashPoint}x`);

    // 1. Public Event: Start round without giving away the crash point to regular users
    io.emit('game_start', { multiplier: 1.00, roundId });

    // 2. Private Event: Send next crash point ONLY to authenticated sockets in 'admin_room'
    io.to('admin_room').emit('admin_next_crash', {
        roundId,
        nextCrash: crashPoint
    });

    gameInterval = setInterval(() => {
        if (multiplier >= crashPoint) {
            isCrashed = true;
            clearInterval(gameInterval);
            console.log(`💥 CRASHED at ${multiplier.toFixed(2)}x`);
            io.emit('game_crash', { multiplier: multiplier.toFixed(2) });

            // Next round after 5 seconds
            setTimeout(startNewGameRound, 5000);
        } else {
            multiplier += 0.03;
            io.emit('multiplier_update', { multiplier: multiplier.toFixed(2) });
        }
    }, 150);
}

// Start game loop when server starts
startNewGameRound();

// Socket connections
io.on('connection', (socket) => {
    console.log(`🔌 Client connected: ${socket.id}`);

    // Allow Admin pages to join secure room
    socket.on('join_admin', (secretKey) => {
        if (secretKey === ADMIN_SECRET_KEY) {
            socket.join('admin_room');
            socket.emit('admin_auth_success', 'Authenticated as Admin');
            console.log(`🔒 Admin joined radar room: ${socket.id}`);
        } else {
            socket.emit('admin_auth_failed', 'Invalid secret key');
            console.log(`⚠️ Admin auth failed for: ${socket.id}`);
        }
    });

    socket.on('disconnect', () => {
        console.log(`❌ Client disconnected: ${socket.id}`);
    });
});

// ==========================================
// 4. SERVER BINDING (CALLED ONCE AT BOTTOM)
// ==========================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Skyrush Game Server running on port ${PORT}`);
});
