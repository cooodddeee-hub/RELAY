import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { requireAuth } from '../middleware/auth.js';
import { loginRateLimit, registerRateLimit } from '../middleware/authRateLimits.js';

const router = Router();
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function issueToken(user) {
  return jwt.sign({ sub: user.id }, process.env.JWT_SECRET, { expiresIn: '12h' });
}

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email };
}

router.post('/register', registerRateLimit, async (req, res, next) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    if (!name || name.length > 100) return res.status(400).json({ message: 'Enter your name (up to 100 characters).' });
    if (!EMAIL_PATTERN.test(email)) return res.status(400).json({ message: 'Enter a valid email address.' });
    if (password.length < 8 || password.length > 128) return res.status(400).json({ message: 'Password must be between 8 and 128 characters.' });

    const existingUser = await User.findOne({ email }).select('_id');
    if (existingUser) return res.status(409).json({ message: 'An account with this email already exists. Sign in instead.' });

    const user = await User.create({ name, email, passwordHash: await bcrypt.hash(password, 12) });
    return res.status(201).json({ token: issueToken(user), user: publicUser(user) });
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ message: 'An account with this email already exists. Sign in instead.' });
    if (error?.name === 'ValidationError') return res.status(400).json({ message: 'Check your name and email, then try again.' });
    return next(error);
  }
});

router.post('/login', loginRateLimit, async (req, res, next) => {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!EMAIL_PATTERN.test(email) || !password) return res.status(400).json({ message: 'Enter a valid email address and password.' });

    const user = await User.findOne({ email });
    if (!user || !await bcrypt.compare(password, user.passwordHash)) {
      return res.status(401).json({ message: 'Email or password is incorrect.' });
    }
    return res.json({ token: issueToken(user), user: publicUser(user) });
  } catch (error) {
    return next(error);
  }
});

router.get('/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

export default router;
