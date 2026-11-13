import { connectDatabase } from '../config/database.js';
import { logError } from '../utils/safeLogger.js';

export async function ensureDatabase(_req, res, next) {
  try {
    await connectDatabase();
    return next();
  } catch (error) {
    logError('database.connect', error, { status: 503 });
    return res.status(503).json({ message: 'Database is temporarily unavailable.' });
  }
}
