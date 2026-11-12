import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import authRoutes from './routes/auth.js';
import projectRoutes from './routes/projects.js';
import sourceRoutes from './routes/sources.js';
import findingRoutes from './routes/findings.js';
import handoverRoutes from './routes/handovers.js';
import { logError } from './utils/safeLogger.js';

const app=express();
app.use(helmet({crossOriginResourcePolicy:{policy:'cross-origin'}}));
app.use(cors({origin:process.env.CLIENT_URL?.split(',') || 'http://localhost:5173'}));
app.use(express.json({limit:'2mb'}));
app.use(rateLimit({windowMs:15*60*1000,max:300}));
app.get('/api/health',(_req,res)=>res.json({status:'ok',service:'RELAY API'}));
app.use('/api/auth',authRoutes);
app.use('/api/projects',projectRoutes);
app.use('/api',sourceRoutes);
app.use('/api',findingRoutes);
app.use('/api',handoverRoutes);
app.use((err,req,res,_next)=>{
  const status=Number(err.status ?? err.statusCode)||500;
  logError(`${req.method} ${req.path}`,err,{status});
  res.status(status).json({message:status>=500?'Internal server error':(err.message||'Request failed')});
});
export default app;
