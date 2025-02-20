// TRADES HANDLING SCRIPT
import WebSocket from 'ws';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const tradeSchema = {
    p_signature: "string",
    p_mint_address: "string",
    p_trader_public_key: "string",
    p_tx_type: "string",
    p_sol_amount: "number",
    p_bonding_curve_key: "string",
    p_v_tokens_in_bonding_curve: "number",
    p_v_sol_in_bonding_curve: "number",
    p_market_cap_sol: "number",
    p_timestamp: "string",
    p_token_amount: "number",
    p_new_token_balance: "number",
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

const startTradeWebSocket = () => {
    const ws = new WebSocket('wss://pumpportal.fun/api/data');

    ws.on('open', () => {
        console.log('🌐 WebSocket connection opened for trades.');
        ws.send(JSON.stringify({ method: 'subscribeTokenTrade' }));
    });

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message.toString());
            if (data.signature && data.txType) {
                console.log('📈 Trade detected:', data);
                const trade = {
                    p_signature: data.signature,
                    p_mint_address: data.mint,
                    p_trader_public_key: data.traderPublicKey || 'N/A',
                    p_tx_type: data.txType,
                    p_sol_amount: data.solAmount || 0,
                    p_bonding_curve_key:
                        ['create', 'buy', 'sell'].includes(data.txType) ? data.bondingCurveKey : null,
                    p_v_tokens_in_bonding_curve: data.vTokensInBondingCurve || 0,
                    p_v_sol_in_bonding_curve: data.vSolInBondingCurve || 0,
                    p_market_cap_sol: data.marketCapSol || 0,
                    p_timestamp: new Date().toISOString(),
                    p_token_amount:
                        data.txType === 'create'
                            ? data.initialBuy || 0
                            : data.tokenAmount || 0,
                    p_new_token_balance:
                        data.txType === 'create'
                            ? data.initialBuy || 0
                            : data.newTokenBalance || 0,
                };

                if (validateData(trade, tradeSchema)) {
                    const { error } = await supabase.rpc('insert_trade', trade);
                    if (error) console.error('❌ Error inserting trade:', error.message);
                    else console.log('✅ Trade inserted successfully.');
                } else console.error('❌ Trade validation failed.');
            }
        } catch (error) {
            console.error('❌ Error processing trade message:', error);
        }
    });

    ws.on('error', (err) => console.error('🚨 Trade WebSocket error:', err));
    ws.on('close', () => console.log('❌ Trade WebSocket closed.'));
};

startTradeWebSocket();
