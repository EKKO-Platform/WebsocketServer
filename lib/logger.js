class Logger {
    logLevel = 'info';

    setLevel(level) {
        this.logLevel = level;
    }

    shouldLog(level) {
        const levels = ['debug', 'info', 'warn', 'error'];
        return levels.indexOf(level) >= levels.indexOf(this.logLevel);
    }

    log(level, message, ...args) {
        if (this.shouldLog(level)) {
            console[level](`[${new Date().toISOString()}] ${message}`, ...args);
        }
    }

    debug(message, ...args) {
        this.log('debug', message, ...args);
    }

    info(message, ...args) {
        this.log('info', message, ...args);
    }

    warn(message, ...args) {
        this.log('warn', message, ...args);
    }

    error(message, ...args) {
        this.log('error', message, ...args);
    }
}

export const logger = new Logger();
