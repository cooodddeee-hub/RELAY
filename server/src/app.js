import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import authRoutes from './routes/auth.js';
import projectRoutes from './routes/projects.js';
import projectWorkflowRoutes from './routes/projectWorkflow.js';
import sourceRoutes from './routes/sources.js';
import findingRoutes from './routes/findings.js';
import handoverRoutes from './routes/handovers.js';
import githubRoutes from './routes/github.js';
import contradictionRoutes from './routes/contradictions.js';
import internalJobRoutes from './routes/internalJobs.js';
import { ensureDatabase } from './middleware/ensureDatabase.js';
import { logError } from './utils/safeLogger.js';
import { validateJwtSecret } from './config/jwtSecret.js';

const app=express();
validateJwtSecret(process.env.JWT_SECRET, { production: process.env.NODE_ENV === 'production' || process.env.VERCEL === '1' });
// Vercel terminates client connections at its trusted proxy. Use one hop so
// IP-based limits see the client address instead of one shared proxy address.
app.set('trust proxy', 1);
const allowedOrigins=(process.env.CLIENT_URL||'http://localhost:5173').split(',').map((origin)=>origin.trim()).filter(Boolean);
const corsOptions={origin(origin,callback){if(origin&&allowedOrigins.includes(origin))return callback(null,true);return callback(null,false)},credentials:true,optionsSuccessStatus:204};
const corsMiddleware=cors(corsOptions);
app.options('*',corsMiddleware,(_req,res)=>res.sendStatus(204));
app.use(helmet({crossOriginResourcePolicy:{policy:'cross-origin'}}));
app.use(corsMiddleware);
app.use(express.json({limit:'2mb'}));
app.use(rateLimit({windowMs:15*60*1000,max:300}));
app.get('/api/health',ensureDatabase,(_req,res)=>res.json({status:'ok',service:'RELAY API'}));
app.use('/api', ensureDatabase);
app.use('/api/internal', internalJobRoutes);
app.use('/api/auth',authRoutes);
app.use('/api/projects',projectRoutes);
app.use('/api',githubRoutes);
app.use('/api/projects',projectWorkflowRoutes);
app.use('/api/projects',contradictionRoutes);
app.use('/api',sourceRoutes);
app.use('/api',findingRoutes);
app.use('/api',handoverRoutes);
app.use((err,req,res,_next)=>{
  const status=Number(err.status ?? err.statusCode)||500;
  logError(`${req.method} ${req.path}`,err,{status});
  res.status(status).json({message:status>=500?'Internal server error':(err.message||'Request failed')});
});
export default app;
