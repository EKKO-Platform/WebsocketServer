import WebSocket from 'ws';
import dotenv from 'dotenv';
dotenv.config();

const startTestWebSocket = () => {
    const ws = new WebSocket('wss://pumpportal.fun/api/data');

    ws.on('open', () => {
        console.log('🌐 WebSocket connection opened');

        // Test different subscription approaches
        console.log('📡 Testing subscriptions...');

        // Test 1: Subscribe with no keys
        ws.send(JSON.stringify({ method: 'subscribeTokenTrade' }));
        console.log('Test 1: Subscribed to trades with no keys');

        // Test 2: Subscribe with empty array
        ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [] }));
        console.log('Test 2: Subscribed to trades with empty keys array');

        // Test 3: Subscribe to Raydium with no keys
        ws.send(JSON.stringify({ method: 'subscribeRaydiumLiquidity' }));
        console.log('Test 3: Subscribed to Raydium with no keys');
    });

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message.toString());

            // Log subscription confirmations
            if (data.message && data.message.includes('Successfully subscribed')) {
                console.log('✅ Subscription confirmed:', data.message);
                return;
            }

            // Log trade data
            if (data.txType && data.mint) {
                console.log('\n📥 Received trade:');
                console.log('  • Type:', data.txType);
                console.log('  • Mint:', data.mint);
                console.log('  • Signature:', data.signature);
                return;
            }

            // Log Raydium data
            if (data.marketId) {
                console.log('\n📊 Received Raydium data:');
                console.log('  • Market:', data.marketId);
                console.log('  • Mint:', data.mint);
                return;
            }

            // Log other messages
            console.log('\n📨 Other message:', data);
        } catch (err) {
            console.error('❌ Error processing message:', err.message);
        }
    });

    ws.on('error', (err) => {
        console.error('🚨 WebSocket error:', err);
    });

    ws.on('close', () => {
        console.log('❌ WebSocket connection closed');
    });
};

// Start test
console.log('🧪 Starting WebSocket subscription test...');
startTestWebSocket();