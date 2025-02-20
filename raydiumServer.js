// RAYDIUM HANDLING SCRIPT
import WebSocket from 'ws';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const raydiumSchema = {
    p_signature: "string",
    p_mint_address: "string",
    p_tx_type: "string",
    p_market_id: "string",
    p_market_cap_sol: "number",
    p_price: "number",
    p_timestamp: "string",
};

const validateData = (data, schema) => {
    for (const [key, type] of Object.entries(schema)) {
        const value = data[key];
        if (value === undefined || value === null) {
            console.error(`❌ Missing required field: ${key}`);
            return false;
        }
        if (typeof value !== type && !(type === 'number' && !isNaN(parseFloat(value)))) {
            console.error(`❌ Invalid type for ${key}: expected ${type}, got ${typeof value}`);
            return false;
        }
    }
    return true;
};

const startRaydiumWebSocket = () => {
    const ws = new WebSocket('wss://pumpportal.fun/api/data');

    ws.on('open', () => {
        console.log('🌐 WebSocket connection opened for Raydium.');
        ws.send(JSON.stringify({ method: 'subscribeRaydiumLiquidity' }));
    });

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message.toString());
            if (data.pool && data.pool === 'raydium') {
                console.log('📡 Raydium liquidity detected:', data);
                const raydium = {
                    p_signature: data.signature,
                    p_mint_address: data.mint,
                    p_tx_type: data.txType,
                    p_market_id: data.marketId,
                    p_market_cap_sol: data.marketCapSol,
                    p_price: data.price,
                    p_timestamp: new Date().toISOString(),
                };

                if (validateData(raydium, raydiumSchema)) {
                    const { error } = await supabase.rpc('insert_migrating', raydium);
                    if (error) console.error('❌ Error inserting Raydium data:', error.message);
                    else console.log('✅ Raydium data inserted successfully.');
                } else console.error('❌ Raydium data validation failed.');
            }
        } catch (error) {
            console.error('❌ Error processing Raydium message:', error);
        }
    });

    ws.on('error', (err) => console.error('🚨 Raydium WebSocket error:', err));
    ws.on('close', () => console.log('❌ Raydium WebSocket closed.'));
};

startRaydiumWebSocket();
