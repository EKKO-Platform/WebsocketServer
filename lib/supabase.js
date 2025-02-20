const { createClient } = require('@supabase/supabase-js');
const { retry } = require('./helpers');
const { logger } = require('./logger');

// Retry configuration
const RETRY_OPTIONS = {
    MAX_RETRIES: 5,
    INITIAL_DELAY: 1000,
    MAX_DELAY: 10000,
};

// Environment configuration
const config = {
    supabase: {
        url: process.env.SUPABASE_URL,
        anonKey: process.env.SUPABASE_ANON_KEY,
    },
};

// Create Supabase client
function createSupabaseClient() {
    try {
        if (!config.supabase.url || !config.supabase.anonKey) {
            logger.error('Missing Supabase credentials');
            throw new Error('Missing Supabase credentials');
        }

        const client = createClient(config.supabase.url, config.supabase.anonKey, {
            auth: {
                autoRefreshToken: true,
                persistSession: true,
                detectSessionInUrl: true,
            },
            db: {
                schema: 'public',
            },
        });

        return client;
    } catch (error) {
        logger.error('Failed to initialize Supabase client:', error);
        throw error;
    }
}

// Singleton instance
const supabase = createSupabaseClient();

// Helper function for retries
async function supabaseQuery(queryFn) {
    return retry(
        async () => {
            try {
                const result = await queryFn();
                if (!result) {
                    throw new Error('No data returned');
                }
                return result;
            } catch (error) {
                if (error.status === 408 || error.message?.includes('timeout')) {
                    logger.warn('Request timeout - retrying...');
                } else if (error.message?.includes('Failed to fetch')) {
                    logger.warn('Network error - retrying...');
                } else {
                    throw error;
                }
            }
        },
        RETRY_OPTIONS.MAX_RETRIES,
        RETRY_OPTIONS.INITIAL_DELAY,
        RETRY_OPTIONS.MAX_DELAY
    );
}

// Configuration check
function isSupabaseConfigured() {
    return !!(config.supabase.url && config.supabase.anonKey);
}

module.exports = {
    supabase,
    supabaseQuery,
    isSupabaseConfigured,
};
