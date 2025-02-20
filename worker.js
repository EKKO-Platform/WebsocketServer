import { parentPort, workerData } from 'worker_threads';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import pkg from 'pg';

const { Pool } = pkg;

dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Create a new pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

const processTokenData = async (data) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const query = `
            INSERT INTO tokens (
                signature, mint_address, trader_public_key, tx_type,
                token_amount, sol_amount, bonding_curve_key,
                v_tokens_in_bonding_curve, v_sol_in_bonding_curve,
                market_cap_sol, name, symbol, uri, timestamp
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            ON CONFLICT (signature) DO UPDATE SET
                mint_address = EXCLUDED.mint_address,
                trader_public_key = EXCLUDED.trader_public_key,
                tx_type = EXCLUDED.tx_type,
                token_amount = EXCLUDED.token_amount,
                sol_amount = EXCLUDED.sol_amount,
                bonding_curve_key = EXCLUDED.bonding_curve_key,
                v_tokens_in_bonding_curve = EXCLUDED.v_tokens_in_bonding_curve,
                v_sol_in_bonding_curve = EXCLUDED.v_sol_in_bonding_curve,
                market_cap_sol = EXCLUDED.market_cap_sol,
                name = EXCLUDED.name,
                symbol = EXCLUDED.symbol,
                uri = EXCLUDED.uri,
                timestamp = EXCLUDED.timestamp
        `;
        const values = [
            data.signature, data.mint, data.traderPublicKey, data.txType,
            data.tokenAmount, data.solAmount, data.bondingCurveKey,
            data.vTokensInBondingCurve, data.vSolInBondingCurve,
            data.marketCapSol, data.name, data.symbol, data.uri,
            new Date(parseInt(data.timestamp)).toISOString()
        ];
        await client.query(query, values);
        await client.query('COMMIT');
        return { success: true, message: 'Token data processed successfully' };
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error processing token data:', error);
        return { success: false, error: error.message };
    } finally {
        client.release();
    }
};

const processTradeData = async (data) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const query = `
            INSERT INTO trades (
                signature, mint_address, trader_public_key, tx_type,
                sol_amount, bonding_curve_key, v_tokens_in_bonding_curve,
                v_sol_in_bonding_curve, market_cap_sol, timestamp,
                token_amount, new_token_balance
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        `;
        const values = [
            data.signature, data.mint, data.traderPublicKey, data.txType,
            data.solAmount, data.bondingCurveKey, data.vTokensInBondingCurve,
            data.vSolInBondingCurve, data.marketCapSol,
            new Date(parseInt(data.timestamp)).toISOString(),
            data.tokenAmount, data.newTokenBalance
        ];
        await client.query(query, values);
        await client.query('COMMIT');
        return { success: true, message: 'Trade data processed successfully' };
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error processing trade data:', error);
        return { success: false, error: error.message };
    } finally {
        client.release();
    }
};

const processRaydiumData = async (data) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const query = `
            INSERT INTO raydium_liquidity (
                signature, mint_address, tx_type, market_id,
                market_cap_sol, price, timestamp
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        `;
        const values = [
            data.signature, data.mint, data.txType, data.marketId,
            data.marketCapSol, data.price,
            new Date(parseInt(data.timestamp)).toISOString()
        ];
        await client.query(query, values);
        await client.query('COMMIT');
        return { success: true, message: 'Raydium data processed successfully' };
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error processing Raydium data:', error);
        return { success: false, error: error.message };
    } finally {
        client.release();
    }
};

parentPort.on('message', async (message) => {
    let result;
    switch (message.type) {
        case 'token':
            result = await processTokenData(message.data);
            break;
        case 'trade':
            result = await processTradeData(message.data);
            break;
        case 'raydium':
            result = await processRaydiumData(message.data);
            break;
        default:
            result = { success: false, error: 'Unknown message type' };
    }
    parentPort.postMessage(result);
});