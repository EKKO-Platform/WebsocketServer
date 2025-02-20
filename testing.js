import WebSocket from 'ws';

const MOCK_SERVER_URL = 'wss://pumpportal.fun/api/data';

const startWebSocket = () => {
    const ws = new WebSocket(MOCK_SERVER_URL);

    ws.on('open', () => {
        console.log('🌐 WebSocket connection opened.');

        // Subscribing to tokens
        console.log('🔔 Subscribing to tokens...');
        ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
    });

    ws.on('message', (message) => {
        console.log('📥 Raw message received:', message.toString());
        try {
            const data = JSON.parse(message.toString());

            // Handle token events
            if (data.type === 'token') {
                console.log(`💎 Token received: ${data.name} (${data.symbol}), Mint: ${data.mint_address}`);

                // Dynamically subscribe to trades and Raydium for this mint_address
                console.log(`🔔 Subscribing to trades for mint: ${data.mint_address}...`);
                ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [data.mint_address] }));

                console.log(`🔔 Subscribing to Raydium activity for mint: ${data.mint_address}...`);
                ws.send(JSON.stringify({ method: 'subscribeRaydiumLiquidity', keys: [data.mint_address] }));
            }

            // Handle trade events
            else if (data.type === 'trade') {
                console.log(`📈 Trade received for mint: ${data.mint_address}, Signature: ${data.signature}`);
            }

            // Handle Raydium events
            else if (data.type === 'raydium') {
                console.log(`📊 Raydium activity received for mint: ${data.mint_address}, Market ID: ${data.marketId}`);
            }

            // Fallback for unexpected messages
            else {
                console.log('⚠️ Unhandled message type:', data);
            }
        } catch (err) {
            console.error('❌ Error parsing message:', err.message);
        }
    });

    ws.on('error', (err) => {
        console.error('🚨 WebSocket error:', err.message);
    });

    ws.on('close', () => {
        console.log('❌ WebSocket connection closed.');
    });
};

startWebSocket();
